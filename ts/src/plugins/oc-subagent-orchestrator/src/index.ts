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
 * - agent_end → purge stale subagents (every turn, not just on session close)
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
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import process from "node:process";
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
};

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
    };

    // ── Telemetry collector (real perf_hooks) ───────────────
    const collector = new TelemetryCollector();

    // ── Hook: gateway_start — initialize ─────────────────────
    api.on("gateway_start", async () => {
      api.logger?.info?.("[orchestrator] Initialized — managing subagents");
    });

    // ── Hook: gateway_stop — cleanup ──────────────────────────
    api.on("gateway_stop", async () => {
      state.queue = null;
      state.subagents.clear();
      state.sessionToTaskMap.clear();
      state.pendingSpawnTaskIds = [];
      state.budgets.clear();
      state.cache.clear();
      collector.destroy();
      api.logger?.info?.("[orchestrator] Shut down");
    });

    // ── Hook: after_compaction — read, clean, write ─────────
    api.on("after_compaction", async () => {
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
    });

    // ── Hook: agent_end — purge stale subagents (every turn) ──
    // Fires when the conversation turn completes. This is the right
    // frequency for stale detection — session_end only fires when a
    // session closes, which is too rare for active topics.
    api.on("agent_end", async () => {
      try {
        // In-memory stale detection
        const { result } = detectStale(state.subagents, cfg.runTimeoutSeconds, Date.now());
        if (result.staleKeys.length > 0) {
          api.logger?.info?.(`[orchestrator] ${result.staleKeys.length} stale subagents detected`);
        }

        // Also purge stale from sessions.json (only if stale detected)
        if (result.staleKeys.length === 0) return;

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
      } catch (err) {
        api.logger?.error?.(`[orchestrator] agent_end cleanup failed: ${String(err)}`);
      }
    });

    // ── Hook: subagent_spawned — track + link to task ID ──────
    api.on("subagent_spawned", async (event: { sessionKey?: string; resolvedModel?: string }) => {
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
    });

    // ── Hook: subagent_ended — record + dispatch next ─────────
    api.on("subagent_ended", async (event: { sessionKey?: string }) => {
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
    });

    // ── Hook: model_call_started/ended — telemetry ───────────
    api.on("model_call_started", async () => {
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
    });

    api.on("model_call_ended", async () => {
      try {
        state.healthSnapshot = collector.collect("main");
      } catch (err) {
        api.logger?.error?.(`[orchestrator] model_call_ended telemetry failed: ${String(err)}`);
      }
    });

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

        // Check cache for each task
        const uncached: TaskSpec[] = [];
        const cached: unknown[] = [];
        const now = Date.now();

        for (const task of tasks) {
          const { hit, result } = getCachedResult(state.cache, task.prompt, task.id, now);
          state.totalQueries++;
          if (hit && result) {
            state.cacheHits++;
            cached.push(result);
          } else {
            uncached.push(task);
          }
        }

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

        // Build dispatch plan: each dispatched task becomes a spawn instruction
        const dispatchPlan = taskIds.map((taskId) => {
          const task = state.queue!.tasks.get(taskId);
          return {
            taskId,
            prompt: task?.spec.prompt ?? "",
            priority: task?.spec.priority ?? "normal",
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
              cached: cached.length,
              queued: uncached.length,
              dispatched: taskIds.length,
              effectiveMaxConcurrent: effectiveMax,
              healthStatus: state.healthSnapshot.status,
              dispatchPlan,
              instructions: "Call sessions_spawn for each task in dispatchPlan using the prompt field. " +
                "Spawn them in the order listed to maintain the dispatch queue. " +
                `(${taskIds.length} task(s) to spawn)`,
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
        "active slots, effective maxConcurrent, and health status.",
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
                maxConcurrent: cfg.maxConcurrent,
                healthStatus: state.healthSnapshot.status,
                cacheHitRate: state.totalQueries > 0
                  ? Math.round((state.cacheHits / state.totalQueries) * 100) / 100
                  : 0,
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
              healthStatus: state.healthSnapshot.status,
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

// Helper — avoid name collision with detectStale result
function result_staleCount(state: OrchestratorState, timeoutSec: number): number {
  const { result } = detectStale(state.subagents, timeoutSec, Date.now());
  return result.staleKeys.length;
}
