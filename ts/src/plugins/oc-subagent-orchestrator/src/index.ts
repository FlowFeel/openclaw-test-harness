/**
 * OC Subagent Orchestrator — the one plugin that manages subagents.
 *
 * Wires all pure logic from tickets #18-#25 into a single plugin:
 * - #18: Work queue dispatcher (queue_work, queue_status, queue_results)
 * - #19: Depth limiter (maxSpawnDepth=2, per-depth timeouts)
 * - #20: Adaptive admission (telemetry-driven throttling)
 * - #21: Result aggregation (merge_results tool)
 * - #22: Priority & preemption (high/normal/low, cooperative yield)
 * - #24: Per-topic isolation (budget allocation, slot borrowing)
 * - #25: Result cache & deduplication (TTL-aware, hit rate)
 *
 * Hooks:
 * - after_compaction → strip bloat fields from sessions.json
 * - session_end → purge stale subagents
 * - subagent_spawned → track in work queue + watchdog
 * - subagent_ended → record result, dispatch next queued task
 * - model_call_started/ended → collect telemetry for adaptive admission
 * - gateway_start → initialize queue, budgets, cache
 * - gateway_stop → cleanup
 *
 * @dft
 * - All pure logic is in shared/ modules (tested without this plugin)
 * - This plugin is the wiring layer — it delegates to pure functions
 * - State is managed in-memory (Map), not in sessions.json
 * - Hook handlers catch errors and log (never block agent runs)
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.ts";
import {
  createQueue,
  dispatchNext,
  recordResult,
  failBlockedTasks,
  getResultsInOrder,
  computeProgress,
  isComplete,
  computeEffectiveMaxConcurrent,
  type WorkQueueState,
  type TaskSpec,
} from "../../shared/work-queue-scheduler.ts";
import {
  canSpawnAtDepth,
  getDepthDecision,
  getCleanupPolicyForDepth,
  DEFAULT_DEPTH_CONFIG,
  type DepthConfig,
} from "../../shared/depth-limiter.ts";
import {
  getAdmissionDecision,
  classifyHealth,
  type SystemHealthSnapshot,
  type AdmissionThresholds,
  DEFAULT_THRESHOLDS,
} from "../../shared/adaptive-admission.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const execFileAsync = promisify(execFile);

import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  mergeResults,
  formatMergedDocument,
  type SubagentResult,
} from "../../shared/result-merger.ts";
import {
  trackSpawn,
  trackEnd,
  detectStale,
  getActiveCount,
  canSpawn,
  type SubagentMap,
} from "../../shared/subagent-tracker.ts";
import {
  allocateBudget,
  canSpawnForTopic,
  borrowSlot,
  computeTopicStats,
  getBottleneckTopic,
  type TopicBudget,
} from "../../shared/topic-isolation.ts";
import {
  insertByPriority,
  shouldPreempt,
  requeuePreempted,
} from "../../shared/priority-scheduler.ts";
import {
  cacheKey,
  getEntry,
  putEntry,
  invalidateExpired,
  getCachedResult,
  mergeAndDedup,
  type CacheStore,
} from "../../shared/result-cache.ts";
import {
  stripBloatFields,
  purgeStaleSubagents,
  cleanupSessions,
  type SessionsMap,
} from "../../shared/session-cleanup.ts";
import { readSessions, writeSessions } from "../../shared/sessions-io.ts";
import { SUBAGENT_KEY } from "../../shared/regex-library.ts";

// ── Plugin state (in-memory, per-gateway) ────────────────────

interface OrchestratorState {
  queue: WorkQueueState | null;
  originalSpecs: TaskSpec[];
  subagents: SubagentMap;
  /** Maps a spawned sessionKey back to the task ID from the work queue */
  sessionToTaskMap: Map<string, string>;
  /** FIFO queue of dispatched task IDs waiting for the model to call sessions_spawn */
  pendingSpawnTaskIds: string[];
  budgets: Map<string, TopicBudget>;
  cache: CacheStore;
  healthSnapshot: SystemHealthSnapshot;
  totalQueries: number;
  cacheHits: number;
  config: OrchestratorConfig;
  /** Crash recovery tracking — incremented by stale watchdog (#39) */
  crashRecoveryReport: {
    recoveredCount: number;
    blockedCount: number;
    newDispatchCount: number;
  };
}

interface OrchestratorConfig {
  maxConcurrent: number;
  maxChildrenPerAgent: number;
  runTimeoutSeconds: number;
  archiveAfterMinutes: number;
  maxSpawnDepth: number;
  bloatFields: string[];
  maxAgeHours: number;
  cacheTtlMs: number;
  staleCheckIntervalMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrent: 6,
  maxChildrenPerAgent: 4,
  runTimeoutSeconds: 300,
  archiveAfterMinutes: 10,
  maxSpawnDepth: 2,
  bloatFields: [
    "compactionCheckpoints",
    "systemPromptReport",
    "skillsSnapshot",
    "contextBudgetStatus",
    "usageFamilySessionIds",
    "lastHeartbeatText",
  ],
  maxAgeHours: 15,
  cacheTtlMs: 86_400_000, // 24h
  staleCheckIntervalMs: 30_000,
};

// ── Workspace root for subprocess calls ────────────────────────

/**
 * Absolute path to the workspace root (lib/python lives here).
 * Falls back to a reasonable default when HOME is not set.
 */
const WORKSPACE_ROOT = resolve(process.env.HOME || "/home/node", ".openclaw/workspace");
const LIB_PYTHON_DIR = resolve(WORKSPACE_ROOT, "lib/python");

// ── SQLite Registry Bridge (persistent cache) ─────────────────

/**
 * Result of a cache check across both in-memory and SQLite stores.
 * @internal Exported for testing only.
 */
export interface CacheCheckResult {
  /** Tasks that had a cache hit (either in-memory or SQLite) */
  cached: unknown[];
  /** Tasks that were not cached and need to be queued */
  uncached: TaskSpec[];
  /** Number of cache hits discovered */
  hitCount: number;
}

/**
 * Pure function: check which tasks are cached and which need queuing.
 *
 * This encapsulates the cache check logic from the queue_work tool,
 * making it testable without I/O. The `sqliteHits` map is pre-computed
 * by the caller (which may involve subprocess I/O).
 *
 * @param tasks - All tasks to check
 * @param cache - The in-memory CacheStore
 * @param nowMs - Current timestamp for TTL checks
 * @param sqliteHits - Pre-computed map of taskId → SQLite cache result
 * @returns Separated cached and uncached tasks with hit count
 *
 * @note This is part of the SQLite registry bridge (#41) — the bridge
 *       between the ephemeral in-memory cache (#25) and the persistent
 *       SQLite search registry (meta/search.db).
 */
export function checkCacheForTasks(
  tasks: TaskSpec[],
  cache: CacheStore,
  nowMs: number,
  sqliteHits: Map<string, unknown> = new Map(),
): CacheCheckResult {
  const cached: unknown[] = [];
  const uncached: TaskSpec[] = [];
  let hitCount = 0;

  for (const task of tasks) {
    // 1. Check in-memory cache first
    const { hit, result } = getCachedResult(cache, task.prompt, task.id, nowMs);
    if (hit && result !== undefined) {
      cached.push(result);
      hitCount++;
      continue;
    }

    // 2. Check SQLite-backed persistent cache (pre-computed by caller)
    const sqliteResult = sqliteHits.get(task.id);
    if (sqliteResult !== undefined) {
      cached.push(sqliteResult);
      hitCount++;
      continue;
    }

    // 3. Not cached — needs to be queued
    uncached.push(task);
  }

  return { cached, uncached, hitCount };
}

/**
 * Query the SQLite-backed persistent cache via phosphene_search.py.
 *
 * This is a bridge between the in-memory result cache (#25) and the
 * persistent SQLite search registry (meta/search.db).
 *
 * The subprocess call is best-effort: if it fails or search.db is
 * unavailable, null is returned and the caller continues without cache.
 *
 * @param query - The search query/prompt to look up
 * @returns A result object if found, or null if not found or on error
 */
export async function checkSqliteCache(
  query: string,
): Promise<{ query: string; ns: string; uri: string; title: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "uv",
      ["run", "python", "scripts/common/phosphene_search.py", query, "--limit", "1"],
      {
        cwd: LIB_PYTHON_DIR,
        timeout: 10_000,
        maxBuffer: 1024 * 64,
      },
    );

    // Parse the output to determine if we got a hit
    // Output format: PHOSPHENE SEARCH: "query"  (N results)
    // If N > 0, the next lines contain the result with score
    const match = stdout.match(/\((\d+) results\)/);
    if (match && parseInt(match[1], 10) > 0) {
      // Extract the first result line: [ns]  uri  —  title
      const lines = stdout.split("\n").filter((l) => l.trim().startsWith("["));
      if (lines.length > 0) {
        const line = lines[0].trim();
        const resultMatch = line.match(/^\[([^\]]+)\]\s+(\S+)\s+—\s+(.+)$/);
        if (resultMatch) {
          return {
            query,
            ns: resultMatch[1],
            uri: resultMatch[2],
            title: resultMatch[3].trim(),
          };
        }
      }
    }

    return null;
  } catch {
    // Subprocess failure is non-fatal — continue without cache
    return null;
  }
}

/**
 * Determine whether a cache hit is sufficiently relevant to skip the task.
 *
 * A hit is considered "cached enough" if it exists (non-null) and has all
 * required fields. The `relevanceThreshold` parameter is accepted for future
 * use when phosphene_search.py outputs a score alongside each result.
 *
 * @param hit - The cache hit result from checkSqliteCache or null
 * @param relevanceThreshold - Minimum relevance score (0-1) to consider a hit
 *   sufficient (default 0.5). Currently unused — kept for forward compatibility
 *   when score is available in parsed output.
 * @returns true if the cache hit should be used to skip the task
 *
 * @pure
 * @example
 * ```ts
 * shouldUseCached({ query: "test", ns: "memory", uri: "doc.md", title: "Doc" });
 * // → true
 *
 * shouldUseCached(null);
 * // → false
 * ```
 */
export function shouldUseCached(
  hit: { query: string; ns: string; uri: string; title: string } | null | undefined,
  _relevanceThreshold: number = 0.5,
): boolean {
  if (!hit) return false;
  // Verify the hit has all required fields
  return Boolean(hit.query && hit.ns && hit.uri && hit.title);
}

// ── TelemetryCollector — real perf_hooks readings ──────────

class TelemetryCollector {
  private monitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private prevCpuUsage: NodeJS.CpuUsage | null = null;
  private prevEventLoopUtil: EventLoopUtilization | null = null;
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
    if (enabled) {
      try {
        this.monitor = monitorEventLoopDelay({ resolution: 10 });
        this.monitor.enable();
        this.prevCpuUsage = process.cpuUsage();
      } catch {
        this.enabled = false;
      }
    }
  }

  /**
   * Collect a telemetry snapshot for the given label.
   * Reads real metrics from Node.js perf_hooks, v8, and process.
   */
  collect(_label: string): SystemHealthSnapshot {
    if (!this.enabled) {
      return {
        status: "healthy",
        eventLoopP99Ms: 0,
        eventLoopUtilization: 0,
        usedHeapSize: 0,
        cpuRatio: 0,
      };
    }

    // Event loop P99 delay (nanoseconds → milliseconds)
    const p99Ns = this.monitor ? this.monitor.percentile(99) : 0;
    const eventLoopP99Ms = p99Ns / 1_000_000;

    // Event loop utilization (0-1)
    const elu = performance.eventLoopUtilization(this.prevEventLoopUtil ?? undefined);
    this.prevEventLoopUtil = elu;
    const eventLoopUtilization = elu.utilization ?? 0;

    // Heap (bytes)
    const heapStats = getHeapStatistics();
    const usedHeapSize = heapStats.used_heap_size;

    // CPU usage delta (microseconds → 0-1 ratio over a ~1s window)
    const currentCpu = process.cpuUsage();
    let cpuRatio = 0;
    if (this.prevCpuUsage) {
      const userDelta = currentCpu.user - this.prevCpuUsage.user;
      const sysDelta = currentCpu.system - this.prevCpuUsage.system;
      const totalDelta = userDelta + sysDelta;
      cpuRatio = Math.min(1, totalDelta / 1_000_000);
    }
    this.prevCpuUsage = currentCpu;

    // Classify status
    const usedHeapMb = usedHeapSize / (1024 * 1024);
    const status = classifyHealth(eventLoopP99Ms, eventLoopUtilization, usedHeapMb);

    return {
      status,
      eventLoopP99Ms,
      eventLoopUtilization,
      usedHeapSize,
      cpuRatio,
    };
  }

  /**
   * Clean up the event loop delay monitor.
   */
  destroy(): void {
    if (this.monitor) {
      try {
        this.monitor.disable();
      } catch {
        // ignore
      }
    }
  }
}

// ── Plugin entry point ───────────────────────────────────────

export default definePluginEntry({
  id: "oc-subagent-orchestrator",
  name: "OC Subagent Orchestrator",
  description:
    "Full subagent management — work queue, depth limiting, adaptive admission, " +
    "priority, topic isolation, result merging, and caching.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = { ...DEFAULT_CONFIG, ...(config as Partial<OrchestratorConfig> ?? {}) };
    const depthConfig: DepthConfig = { ...DEFAULT_DEPTH_CONFIG, maxSpawnDepth: cfg.maxSpawnDepth };

    const state: OrchestratorState = {
      queue: null,
      originalSpecs: [],
      subagents: new Map(),
      sessionToTaskMap: new Map(),
      pendingSpawnTaskIds: [],
      budgets: new Map(),
      cache: new Map(),
      healthSnapshot: {
        status: "healthy",
        eventLoopP99Ms: 0,
        eventLoopUtilization: 0,
        usedHeapSize: 0,
        cpuRatio: 0,
      },
      totalQueries: 0,
      cacheHits: 0,
      config: cfg,
      crashRecoveryReport: { recoveredCount: 0, blockedCount: 0, newDispatchCount: 0 },
    };

    // ── Telemetry collector (real perf_hooks) ───────────────
    const collector = new TelemetryCollector();

    // ── Hook: gateway_start — initialize ─────────────────────
    api.registerHook("gateway_start", async () => {
      api.logger?.info?.("[orchestrator] Initialized — managing subagents");
    }, { name: "orchestrator-gateway-start" });

    // ── Hook: gateway_stop — cleanup ──────────────────────────
    api.registerHook("gateway_stop", async () => {
      state.queue = null;
      state.subagents.clear();
      state.sessionToTaskMap.clear();
      state.pendingSpawnTaskIds = [];
      state.budgets.clear();
      state.cache.clear();
      collector.destroy();
      api.logger?.info?.("[orchestrator] Shut down");
    }, { name: "orchestrator-gateway-stop" });

    // ── Hook: after_compaction — read, clean, write ─────────
    api.registerHook("after_compaction", async () => {
      try {
        const sessions = readSessions();
        if (sessions) {
          const { cleaned, report } = cleanupSessions(sessions, {
            bloatFields: cfg.bloatFields,
            maxAgeHours: cfg.maxAgeHours,
            nowMs: Date.now(),
          });
          writeSessions(cleaned);
          api.logger?.info?.(
            `[orchestrator] Post-compaction cleanup: ` +
            `${report.beforeCount}→${report.afterCount} entries, ` +
            `${report.reductionPercent}% size reduction, ` +
            `${report.strippedFieldCount} fields stripped`
          );
        }
      } catch (err) {
        api.logger?.error?.(`[orchestrator] after_compaction failed: ${String(err)}`);
      }
    }, { name: "orchestrator-after-compaction" });

    // ── Hook: session_end — stale watchdog + purge ────────────
    api.registerHook("session_end", async () => {
      try {
        // Detect stale subagents and fail their tasks
        const staleResult = detectStaleAndFail(
          state.subagents,
          state.queue,
          state.sessionToTaskMap,
          cfg.runTimeoutSeconds,
          cfg.maxConcurrent,
          state.healthSnapshot.status,
          Date.now()
        );

        // Apply state updates from stale detection
        state.subagents = staleResult.subagents;
        state.queue = staleResult.queue;
        state.sessionToTaskMap = staleResult.sessionToTaskMap;

        if (staleResult.staleCount > 0) {
          api.logger?.info?.(
            `[orchestrator] ${staleResult.staleCount} stale subagent(s) detected and failed: ` +
            staleResult.staleKeys.join(", ")
          );

          // Accumulate crash recovery report
          state.crashRecoveryReport.recoveredCount += staleResult.staleCount;
          state.crashRecoveryReport.blockedCount += staleResult.blockedCount;
          state.crashRecoveryReport.newDispatchCount += staleResult.newDispatchCount;

          api.logger?.info?.(
            `[orchestrator] Crash recovery: ${staleResult.staleCount} recovered, ` +
            `${staleResult.blockedCount} blocked, ${staleResult.newDispatchCount} new dispatches`
          );

          // Queue newly dispatched tasks for spawning
          if (staleResult.spawnInstructions.length > 0) {
            state.pendingSpawnTaskIds.push(
              ...staleResult.spawnInstructions.map((s) => s.taskId)
            );
            api.logger?.info?.(
              `[orchestrator] Dispatched ${staleResult.spawnInstructions.length} ` +
              `replacement task(s) — spawnInstructions: ${JSON.stringify(staleResult.spawnInstructions)}`
            );
          }
        }

        // Also purge stale from sessions.json
        const sessions = readSessions();
        if (sessions) {
          const { cleaned, purgedKeys } = purgeStaleSubagents(sessions, {
            maxAgeHours: cfg.maxAgeHours,
            nowMs: Date.now(),
          });
          if (purgedKeys.length > 0) {
            writeSessions(cleaned);
            api.logger?.info?.(
              `[orchestrator] Purged ${purgedKeys.length} stale sessions from sessions.json`
            );
          }
        }
        // Write heartbeat summary (best-effort)
        try {
          const heartbeatSummary = generateHeartbeatSummary(
            state.subagents,
            state.queue,
            state.totalQueries,
            state.cacheHits,
            state.healthSnapshot,
            cfg.runTimeoutSeconds,
            cfg.maxConcurrent,
            Date.now()
          );
          const heartbeatDir = resolve(process.cwd(), "drafts/platform");
          mkdirSync(heartbeatDir, { recursive: true });
          writeFileSync(
            resolve(heartbeatDir, "orchestrator-heartbeat-latest.json"),
            heartbeatSummary,
            "utf8"
          );
          api.logger?.info?.("[orchestrator] Heartbeat summary written");
        } catch (hbErr) {
          api.logger?.warn?.(`[orchestrator] Heartbeat write failed: ${String(hbErr)}`);
        }
      } catch (err) {
        api.logger?.error?.(`[orchestrator] session_end failed: ${String(err)}`);
      }
    }, { name: "orchestrator-session-end" });

    // ── Hook: subagent_spawned — track + link to task ID ──────
    api.registerHook("subagent_spawned", async (event: { sessionKey?: string; resolvedModel?: string }) => {
      if (!event.sessionKey) return;

      // Link this spawned session to the next pending task ID (FIFO order)
      const taskId = state.pendingSpawnTaskIds.shift();
      if (taskId) {
        state.sessionToTaskMap.set(event.sessionKey, taskId);
      }

      state.subagents = trackSpawn(state.subagents, {
        sessionKey: event.sessionKey,
        model: event.resolvedModel,
        startedAtMs: Date.now(),
      }, Date.now());

      const linkInfo = taskId ? ` linked to task ${taskId}` : "";
      api.logger?.info?.(
        `[orchestrator] Tracked spawn: ${event.sessionKey}${linkInfo} ` +
        `(active: ${getActiveCount(state.subagents)}/${cfg.maxConcurrent})`
      );
    }, { name: "orchestrator-subagent-spawned" });

    // ── Hook: subagent_ended — record + dispatch next ─────────
    api.registerHook("subagent_ended", async (event: { sessionKey?: string }) => {
      if (!event.sessionKey) return;
      state.subagents = trackEnd(state.subagents, event.sessionKey, Date.now());

      // Look up the task ID from the session-to-task mapping
      const taskId = state.sessionToTaskMap.get(event.sessionKey);
      state.sessionToTaskMap.delete(event.sessionKey);

      // If we have a queue and a mapped task ID, record the result and dispatch next
      if (state.queue && taskId) {
        state.queue = recordResult(state.queue, taskId, { completed: true }, Date.now());
        state.queue = failBlockedTasks(state.queue);

        // Dispatch next queued tasks — add newly dispatched to pending spawn queue
        const effectiveMax = computeEffectiveMaxConcurrent(
          cfg.maxConcurrent,
          state.healthSnapshot.status
        );
        const { taskIds, state: newState } = dispatchNext(state.queue, effectiveMax, Date.now());
        state.queue = newState;

        if (taskIds.length > 0) {
          // Add newly dispatched task IDs to the pending spawn queue
          state.pendingSpawnTaskIds.push(...taskIds);
          api.logger?.info?.(
            `[orchestrator] Dispatched ${taskIds.length} next task(s) — ` +
            `pending spawns: ${state.pendingSpawnTaskIds.length}`
          );
        }
      }
    }, { name: "orchestrator-subagent-ended" });

    // ── Hook: model_call_started/ended — telemetry ───────────
    api.registerHook("model_call_started", async () => {
      try {
        state.healthSnapshot = collector.collect("main");
        api.logger?.info?.(
          `[orchestrator] Telemetry: P99=${Math.round(state.healthSnapshot.eventLoopP99Ms)}ms, ` +
          `util=${Math.round(state.healthSnapshot.eventLoopUtilization * 100)}%, ` +
          `heap=${Math.round(state.healthSnapshot.usedHeapSize / (1024 * 1024))}MB, ` +
          `cpu=${Math.round(state.healthSnapshot.cpuRatio * 100)}%, ` +
          `status=${state.healthSnapshot.status}`
        );
      } catch (err) {
        api.logger?.error?.(`[orchestrator] model_call_started telemetry failed: ${String(err)}`);
      }
    }, { name: "orchestrator-model-call-started" });

    api.registerHook("model_call_ended", async () => {
      try {
        state.healthSnapshot = collector.collect("main");
      } catch (err) {
        api.logger?.error?.(`[orchestrator] model_call_ended telemetry failed: ${String(err)}`);
      }
    }, { name: "orchestrator-model-call-ended" });

    // ═══════════════════════════════════════════════════════════
    // Tools
    // ═══════════════════════════════════════════════════════════

    // ── Tool: queue_work ───────────────────────────────────────
    api.registerTool({
      name: "queue_work",
      description:
        "Queue a batch of subagent tasks for parallel dispatch. " +
        "Tasks are dispatched across maxConcurrent slots, respecting " +
        "dependencies and priority. Returns the number of tasks dispatched.",
      parameters: Type.Object({
        tasks: Type.Any({
          description: "Array of task specs: { id, prompt, priority?, dependsOn? }",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const tasks = params.tasks as TaskSpec[];
        if (!Array.isArray(tasks)) {
          return { content: [{ type: "text" as const, text: "tasks must be an array" }] };
        }

        // Check cache for each task — in-memory first, then SQLite registry
        // This is the bridge between the in-memory cache (#25) and the
        // persistent SQLite search registry (#41).
        const now = Date.now();

        // Query SQLite-backed persistent cache for all tasks in parallel
        const sqliteHits = new Map<string, unknown>();
        const sqlitePromises = tasks.map(async (task) => {
          const sqliteResult = await checkSqliteCache(task.prompt);
          if (sqliteResult !== null) {
            // Store in in-memory cache for subsequent lookups
            const key = cacheKey(task.prompt, task.id);
            state.cache = putEntry(state.cache, key, sqliteResult, now, state.config.cacheTtlMs);
            sqliteHits.set(task.id, sqliteResult);
          }
        });
        await Promise.allSettled(sqlitePromises);

        // Use the pure cache check function (testable without I/O)
        const { cached, uncached, hitCount } = checkCacheForTasks(
          tasks, state.cache, now, sqliteHits,
        );

        state.totalQueries += tasks.length;
        state.cacheHits += hitCount;

        // Check depth limit
        const depthDecision = getDepthDecision(0, depthConfig);
        if (!depthDecision.allowed) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot queue: ${depthDecision.reason}`,
            }],
          };
        }

        // Check admission
        const activeCount = getActiveCount(state.subagents);
        const admission = getAdmissionDecision(
          state.healthSnapshot,
          activeCount,
          cfg.maxConcurrent,
          DEFAULT_THRESHOLDS
        );
        if (!admission.allowed) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot spawn: ${admission.reason}`,
            }],
          };
        }

        // Create queue (with priority ordering) and dispatch
        const queue = createQueue(uncached);
        state.queue = queue;
        state.originalSpecs = uncached;

        const effectiveMax = computeEffectiveMaxConcurrent(
          cfg.maxConcurrent,
          state.healthSnapshot.status
        );
        const { taskIds, state: newState } = dispatchNext(queue, effectiveMax, now);
        state.queue = newState;

        // Build spawn instructions: each dispatched task becomes a spawn instruction
        const spawnInstructions = taskIds.map((taskId) => {
          const task = state.queue!.tasks.get(taskId);
          return {
            taskId,
            prompt: task?.spec.prompt ?? "",
            taskName: task?.spec.id ?? taskId,
          };
        });

        // Add dispatched task IDs to the pending spawn queue (FIFO)
        state.pendingSpawnTaskIds.push(...taskIds);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              totalTasks: tasks.length,
              cachedCount: hitCount,
              dispatched: taskIds.length,
              spawnInstructions,
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool: queue_status ────────────────────────────────────
    api.registerTool({
      name: "queue_status",
      description:
        "Check the status of the subagent work queue — " +
        "total/queued/dispatched/completed/failed counts, " +
        "active slots, effective maxConcurrent, staleCount, " +
        "and health status.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        if (!state.queue) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                queueActive: false,
                message: "No active work queue",
                activeSubagents: getActiveCount(state.subagents),
                staleCount: result_staleCount(state, cfg.runTimeoutSeconds),
                maxConcurrent: cfg.maxConcurrent,
                healthStatus: state.healthSnapshot.status,
                cacheHitRate: state.totalQueries > 0
                  ? Math.round((state.cacheHits / state.totalQueries) * 100) / 100
                  : 0,
                crashRecoveryReport: state.crashRecoveryReport,
              }, null, 2),
            }],
          };
        }

        const effectiveMax = computeEffectiveMaxConcurrent(
          cfg.maxConcurrent,
          state.healthSnapshot.status
        );
        const progress = computeProgress(state.queue, effectiveMax);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              queueActive: true,
              ...progress,
              pendingSpawnCount: state.pendingSpawnTaskIds.length,
              activeSubagents: getActiveCount(state.subagents),
              staleCount: result_staleCount(state, cfg.runTimeoutSeconds),
              healthStatus: state.healthSnapshot.status,
              crashRecoveryReport: state.crashRecoveryReport,
              eventLoopP99Ms: Math.round(state.healthSnapshot.eventLoopP99Ms * 100) / 100,
              cacheHitRate: state.totalQueries > 0
                ? Math.round((state.cacheHits / state.totalQueries) * 100) / 100
                : 0,
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool: queue_results ────────────────────────────────────
    api.registerTool({
      name: "queue_results",
      description:
        "Get results from the work queue in original task order. " +
        "Incomplete tasks have undefined results. " +
        "Pass merge=true to merge and deduplicate results.",
      parameters: Type.Object({
        merge: Type.Any({
          description: "If true, merge and deduplicate results",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!state.queue) {
          return {
            content: [{ type: "text" as const, text: "No active work queue" }],
          };
        }

        const results = getResultsInOrder(state.queue, state.originalSpecs);

        if (params.merge) {
          // Collect completed results for merging
          const subagentResults: SubagentResult[] = results
            .filter((r) => r.result !== undefined)
            .map((r) => ({
              taskId: r.spec.id,
              taskType: "search",
              findings: [],
              citations: Array.isArray(r.result) ? r.result : [],
            }));

          if (subagentResults.length > 0) {
            const { merged, report } = mergeResults(subagentResults);
            return {
              content: [{
                type: "text" as const,
                text: formatMergedDocument(merged) + "\n\n---\n" + JSON.stringify(report, null, 2),
              }],
            };
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(results.map((r) => ({
              id: r.spec.id,
              status: r.status,
              hasResult: r.result !== undefined,
            })), null, 2),
          }],
        };
      },
    });

    // ── Tool: subagent_health ──────────────────────────────────
    api.registerTool({
      name: "subagent_health",
      description:
        "Check subagent health — active count, stale detection, " +
        "spawn availability, depth limits, and per-depth timeouts.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const { result } = detectStale(state.subagents, cfg.runTimeoutSeconds, Date.now());
        const activeCount = getActiveCount(state.subagents);
        const effectiveMax = computeEffectiveMaxConcurrent(
          cfg.maxConcurrent,
          state.healthSnapshot.status
        );
        const canSpawnNow = activeCount < effectiveMax;
        const depthDecision = getDepthDecision(0, depthConfig);

        const heartbeatSummary = generateHeartbeatSummary(
          state.subagents,
          state.queue,
          state.totalQueries,
          state.cacheHits,
          state.healthSnapshot,
          cfg.runTimeoutSeconds,
          cfg.maxConcurrent,
          Date.now()
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              activeCount,
              staleCount: result.staleKeys.length,
              staleKeys: result.staleKeys,
              maxConcurrent: cfg.maxConcurrent,
              effectiveMaxConcurrent: effectiveMax,
              canSpawn: canSpawnNow,
              healthStatus: state.healthSnapshot.status,
              maxSpawnDepth: cfg.maxSpawnDepth,
              depth1Timeout: getDepthDecision(0, depthConfig).timeoutSeconds,
              depth2Timeout: getDepthDecision(1, depthConfig).timeoutSeconds,
              heartbeatSummary: JSON.parse(heartbeatSummary),
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool: session_health ──────────────────────────────────
    api.registerTool({
      name: "session_health",
      description:
        "Check sessions.json health — file size, entry count, subagent count. " +
        "Run before and after compaction to monitor bloat.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        // Read actual sessions.json for file metrics
        let fileMetrics = {
          fileSizeBytes: 0,
          entryCount: 0,
          subagentEntryCount: 0,
        };
        try {
          const sessions = readSessions();
          if (sessions) {
            const entries = Object.entries(sessions);
            fileMetrics.entryCount = entries.length;
            fileMetrics.subagentEntryCount = entries.filter(([k]) => SUBAGENT_KEY.test(k)).length;
            fileMetrics.fileSizeBytes = Buffer.byteLength(JSON.stringify(sessions, null, 0), "utf8");
          }
        } catch {
          // File not accessible — report zeroes
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              ...fileMetrics,
              bloatFieldsTracked: cfg.bloatFields.length,
              maxAgeHours: cfg.maxAgeHours,
              staleSubagentCount: result_staleCount(state, cfg.runTimeoutSeconds),
              cacheSize: state.cache.size,
              cacheHitRate: state.totalQueries > 0
                ? Math.round((state.cacheHits / state.totalQueries) * 100) / 100
                : 0,
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool: merge_results ────────────────────────────────────
    api.registerTool({
      name: "merge_results",
      description:
        "Merge multiple subagent results into a single document with " +
        "deduplication by citation key (DOI/URL), relevance sorting, " +
        "and per-source attribution.",
      parameters: Type.Object({
        results: Type.Any({
          description: "Array of subagent results to merge",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const results = params.results as SubagentResult[];
        if (!Array.isArray(results)) {
          return { content: [{ type: "text" as const, text: "results must be an array" }] };
        }

        const { merged, report } = mergeResults(results);
        return {
          content: [{
            type: "text" as const,
            text: formatMergedDocument(merged) + "\n\n---\n" + JSON.stringify(report, null, 2),
          }],
        };
      },
    });

    // ── Tool: event_loop_health ────────────────────────────────
    api.registerTool({
      name: "event_loop_health",
      description:
        "Report event loop health — P99 delay, utilization, heap usage, " +
        "CPU ratio, and overall status (healthy/degraded/critical). " +
        "Drives adaptive admission throttling.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              status: state.healthSnapshot.status,
              eventLoopP99Ms: Math.round(state.healthSnapshot.eventLoopP99Ms * 100) / 100,
              eventLoopUtilization: Math.round(state.healthSnapshot.eventLoopUtilization * 1000) / 1000,
              usedHeapMB: Math.round(state.healthSnapshot.usedHeapSize / (1024 * 1024)),
              cpuRatio: Math.round(state.healthSnapshot.cpuRatio * 1000) / 1000,
              effectiveMaxConcurrent: computeEffectiveMaxConcurrent(
                cfg.maxConcurrent,
                state.healthSnapshot.status
              ),
            }, null, 2),
          }],
        };
      },
    });
  },
});

// ── generateHeartbeatSummary — heartbeat JSON for business report ──

/**
 * Generate a heartbeat summary JSON string from the orchestrator state.
 * Used by subagent_health tool and session_end heartbeat file write.
 *
 * Pure function — no side effects, no I/O.
 */
function generateHeartbeatSummary(
  subagents: SubagentMap,
  queue: WorkQueueState | null,
  totalQueries: number,
  cacheHits: number,
  healthSnapshot: SystemHealthSnapshot,
  runTimeoutSeconds: number,
  maxConcurrent: number,
  nowMs: number
): string {
  const { result } = detectStale(subagents, runTimeoutSeconds, nowMs);
  const activeCount = getActiveCount(subagents);
  const effectiveMax = computeEffectiveMaxConcurrent(maxConcurrent, healthSnapshot.status);

  const queueProgress = queue
    ? computeProgress(queue, effectiveMax)
    : null;

  const cacheHitRate = totalQueries > 0
    ? Math.round((cacheHits / totalQueries) * 100) / 100
    : 0;

  return JSON.stringify({
    activeSubagents: activeCount,
    staleSubagents: result.staleKeys.length,
    queueActive: queue !== null,
    queueProgress: queueProgress
      ? {
          total: queueProgress.total,
          completed: queueProgress.completed,
          failed: queueProgress.failed,
          queued: queueProgress.queued,
        }
      : { total: 0, completed: 0, failed: 0, queued: 0 },
    cacheHitRate,
    healthStatus: healthSnapshot.status,
    effectiveMaxConcurrent: effectiveMax,
    generatedAt: new Date(nowMs).toISOString(),
  }, null, 2);
}


// ── Exported: detectStaleAndFail — pure function for testing ──

/**
 * Detect stale subagents, record their tasks as failed, cascade
 * failures to dependents, and dispatch next queued tasks to fill
 * freed slots.
 *
 * Pure function — no side effects, no I/O. All timestamps injected.
 *
 * @returns Updated state maps and any newly dispatched spawn instructions.
 */
export function detectStaleAndFail(
  subagents: SubagentMap,
  queue: WorkQueueState | null,
  sessionToTaskMap: Map<string, string>,
  runTimeoutSeconds: number,
  maxConcurrent: number,
  healthStatus: "healthy" | "degraded" | "critical",
  nowMs: number
): {
  staleCount: number;
  staleKeys: string[];
  subagents: SubagentMap;
  queue: WorkQueueState | null;
  sessionToTaskMap: Map<string, string>;
  spawnInstructions: Array<{ taskId: string; prompt: string; taskName: string }>;
  blockedCount: number;
  newDispatchCount: number;
} {
  const { stale, fresh, result } = detectStale(subagents, runTimeoutSeconds, nowMs);
  const staleKeys = result.staleKeys;
  let updatedQueue = queue;
  let updatedSessionToTaskMap = new Map(sessionToTaskMap);
  const spawnInstructions: Array<{ taskId: string; prompt: string; taskName: string }> = [];
  let blockedCount = 0;
  let newDispatchCount = 0;

  if (staleKeys.length > 0 && updatedQueue) {
    // Mark each stale subagent's task as failed
    for (const staleKey of staleKeys) {
      const taskId = updatedSessionToTaskMap.get(staleKey);
      if (taskId) {
        updatedQueue = recordResult(
          updatedQueue,
          taskId,
          "subagent crashed or timed out",
          nowMs,
          false
        );
        updatedSessionToTaskMap.delete(staleKey);
      }
    }

    // Count tasks before failing blocked, to compute blocked count
    const beforeFailBlockedCount = Array.from(updatedQueue.tasks.values()).filter(
      (t) => t.status === "queued"
    ).length;

    // Cascade failures to dependents
    updatedQueue = failBlockedTasks(updatedQueue);

    // Count blocked tasks: queued before - queued after = newly failed
    const afterFailBlockedCount = Array.from(updatedQueue.tasks.values()).filter(
      (t) => t.status === "queued"
    ).length;
    blockedCount = beforeFailBlockedCount - afterFailBlockedCount;

    // Dispatch next tasks to fill freed slots
    const effectiveMax = computeEffectiveMaxConcurrent(maxConcurrent, healthStatus);
    const { taskIds, state: newState } = dispatchNext(updatedQueue, effectiveMax, nowMs);
    updatedQueue = newState;
    newDispatchCount = taskIds.length;

    // Build spawn instructions for newly dispatched tasks
    for (const taskId of taskIds) {
      const task = updatedQueue.tasks.get(taskId);
      spawnInstructions.push({
        taskId,
        prompt: task?.spec.prompt ?? "",
        taskName: task?.spec.id ?? taskId,
      });
    }
  }

  return {
    staleCount: staleKeys.length,
    staleKeys,
    subagents: fresh,
    queue: updatedQueue,
    sessionToTaskMap: updatedSessionToTaskMap,
    spawnInstructions,
    blockedCount,
    newDispatchCount,
  };
}

// Helper — avoid name collision with detectStale result
function result_staleCount(state: OrchestratorState, timeoutSec: number): number {
  const { result } = detectStale(state.subagents, timeoutSec, Date.now());
  return result.staleKeys.length;
}
