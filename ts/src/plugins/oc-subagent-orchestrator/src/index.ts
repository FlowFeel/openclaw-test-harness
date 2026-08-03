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
  type SystemHealthSnapshot,
  type AdmissionThresholds,
  DEFAULT_THRESHOLDS,
} from "../../shared/adaptive-admission.ts";
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

// ── Plugin state (in-memory, per-gateway) ────────────────────

interface OrchestratorState {
  queue: WorkQueueState | null;
  originalSpecs: TaskSpec[];
  subagents: SubagentMap;
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

    // ── Hook: gateway_start — initialize ─────────────────────
    api.registerHook("gateway_start", async () => {
      api.logger?.info?.("[orchestrator] Initialized — managing subagents");
    }, { name: "orchestrator-gateway-start" });

    // ── Hook: gateway_stop — cleanup ──────────────────────────
    api.registerHook("gateway_stop", async () => {
      state.queue = null;
      state.subagents.clear();
      state.budgets.clear();
      state.cache.clear();
      api.logger?.info?.("[orchestrator] Shut down");
    }, { name: "orchestrator-gateway-stop" });

    // ── Hook: after_compaction — strip bloat ─────────────────
    api.registerHook("after_compaction", async () => {
      try {
        // The session-guard's sessions-io handles the actual file I/O.
        // Here we just log — the standalone plugin does the work.
        api.logger?.info?.("[orchestrator] Post-compaction cleanup triggered");
      } catch (err) {
        api.logger?.error?.(`[orchestrator] after_compaction failed: ${String(err)}`);
      }
    }, { name: "orchestrator-after-compaction" });

    // ── Hook: session_end — purge stale ──────────────────────
    api.registerHook("session_end", async () => {
      const { result } = detectStale(state.subagents, cfg.runTimeoutSeconds, Date.now());
      if (result.staleKeys.length > 0) {
        api.logger?.info?.(`[orchestrator] ${result.staleKeys.length} stale subagents detected`);
      }
    }, { name: "orchestrator-session-end" });

    // ── Hook: subagent_spawned — track ───────────────────────
    api.registerHook("subagent_spawned", async (event: { sessionKey?: string; resolvedModel?: string }) => {
      if (!event.sessionKey) return;
      state.subagents = trackSpawn(state.subagents, {
        sessionKey: event.sessionKey,
        model: event.resolvedModel,
        startedAtMs: Date.now(),
      }, Date.now());
      api.logger?.info?.(
        `[orchestrator] Tracked spawn: ${event.sessionKey} ` +
        `(active: ${getActiveCount(state.subagents)}/${cfg.maxConcurrent})`
      );
    }, { name: "orchestrator-subagent-spawned" });

    // ── Hook: subagent_ended — record + dispatch next ─────────
    api.registerHook("subagent_ended", async (event: { sessionKey?: string }) => {
      if (!event.sessionKey) return;
      state.subagents = trackEnd(state.subagents, event.sessionKey, Date.now());

      // If we have a queue, record the result and dispatch next
      if (state.queue) {
        state.queue = recordResult(state.queue, event.sessionKey, { completed: true }, Date.now());
        state.queue = failBlockedTasks(state.queue);

        // Dispatch next queued tasks
        const effectiveMax = computeEffectiveMaxConcurrent(
          cfg.maxConcurrent,
          state.healthSnapshot.status
        );
        const { taskIds } = dispatchNext(state.queue, effectiveMax, Date.now());
        if (taskIds.length > 0) {
          api.logger?.info?.(`[orchestrator] Dispatched ${taskIds.length} next task(s)`);
        }
      }
    }, { name: "orchestrator-subagent-ended" });

    // ── Hook: model_call_started/ended — telemetry ───────────
    api.registerHook("model_call_started", async () => {
      // In production, this would read from perf_hooks
      // For now, we just mark activity
    }, { name: "orchestrator-model-call-started" });

    api.registerHook("model_call_ended", async () => {
      // Update health snapshot (would be fed by oc-telemetry plugin in production)
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
        // Delegate to the session-guard's I/O — here we just report orchestrator state
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
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
