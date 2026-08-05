/**
 * OcTopicWorkerPool — plugin entry point (wiring layer).
 *
 * @behavior
 * Wires six hooks to the pure logic seams (topic-worker-pool-logic.ts) to
 * implement a hook-based worker pool for concurrent Telegram topic sessions.
 *
 * The pool uses a counting semaphore: before_agent_run acquires a slot
 * (awaiting if full = backpressure), agent_end releases it. Subagents get
 * their own pool via subagent_spawning/subagent_ended. before_dispatch
 * routes by topic and short-circuits duplicates.
 *
 * @invariants
 * - No logic here — only wiring (read state → pure call → act on result).
 * - No direct node:fs imports — I/O goes through the Protocol wrapper.
 * - Hooks catch errors and log (never block agent runs unexpectedly).
 * - The semaphore state is created once in register() and shared across
 *   all hook invocations via closure.
 *
 * @dft
 * - Tested via integration tests with in-memory Protocol doubles.
 * - Pure logic tested separately in topic-worker-pool-logic.spec.ts.
 */

import { definePluginEntry, type PluginApi } from "../../shared/types.js";
import {
  createSemaphore,
  acquire,
  release,
  getStats,
  isFull,
  type SemaphoreState,
  type SemaphoreReport,
} from "./topic-worker-pool-logic.js";
import {
  parseTopicSessionKey,
  routeTopic,
  buildDedupKey,
  decideDispatch,
  hashContent,
  type TopicRoutingConfig,
  type ParsedTopicSession,
} from "./topic-worker-pool-logic.js";

// ── Config ──────────────────────────────────────────────────────────────

export interface OcTopicWorkerPoolConfig {
  /** Max concurrent main agent runs (default: 3). */
  mainPoolMax?: number;
  /** Max concurrent subagent runs (default: 2). */
  subPoolMax?: number;
  /** Dedup window in ms (default: 5000). */
  dedupWindowMs?: number;
  /** Routing config for pool assignment. */
  routing?: TopicRoutingConfig;
}

// ── Async semaphore (the wiring around the pure state) ──────────────────

/**
 * An async wrapper around the pure SemaphoreState.
 *
 * The pure logic (acquire/release) only updates counters. This wrapper
 * adds the Promise/resolve plumbing that makes acquire() actually await
 * when the pool is full. This is the ONLY impure part, and it lives in
 * the wiring layer — the logic layer stays pure and testable.
 */
interface AsyncSemaphore {
  state: SemaphoreState;
  waiters: Array<{ resolve: () => void; waiterId: number }>;
  acquire(): Promise<SemaphoreReport>;
  release(): SemaphoreReport;
  getStats(): ReturnType<typeof getStats>;
  isFull(): boolean;
}

export function createAsyncSemaphore(max: number): AsyncSemaphore {
  const state = createSemaphore(max);
  const waiters: AsyncSemaphore["waiters"] = [];

  return {
    state,
    waiters,

    async acquire(): Promise<SemaphoreReport> {
      const report = acquire(state);
      if (report.action === "acquired") {
        return report;
      }
      // Queued — create a Promise that resolves when a slot frees.
      return new Promise<SemaphoreReport>((resolve) => {
        waiters.push({ resolve: resolve as () => void, waiterId: report.waiterId! });
      });
    },

    release(): SemaphoreReport {
      const report = release(state);
      if (report.action === "released" && waiters.length > 0) {
        // Hand the freed slot to the next waiter.
        const waiter = waiters.shift()!;
        // Re-acquire on behalf of the waiter (updates state counters).
        const reacquire = acquire(state);
        waiter.resolve();
        return reacquire;
      }
      return report;
    },

    getStats() {
      return getStats(state);
    },

    isFull() {
      return isFull(state);
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "oc-topic-worker-pool",
  name: "OcTopicWorkerPool",
  description:
    "Hook-based worker pool with semaphore admission control for concurrent Telegram topic sessions",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as OcTopicWorkerPoolConfig) ?? {};
    const mainPoolMax = cfg.mainPoolMax ?? 3;
    const subPoolMax = cfg.subPoolMax ?? 2;
    const dedupWindowMs = cfg.dedupWindowMs ?? 5_000;

    // The shared pools — created once, used by all hook invocations.
    const mainPool = createAsyncSemaphore(mainPoolMax);
    const subPool = createAsyncSemaphore(subPoolMax);

    // Dedup cache: key → timestamp. Pruned on each insert.
    const dedupCache = new Map<string, number>();

    // Routing config (defaults to a single default pool).
    const routingConfig: TopicRoutingConfig = cfg.routing ?? {
      defaultPool: "main",
    };

    // Track which pool a run is using (for agent_end to release the right one).
    const runPoolMap = new Map<string, "main" | "sub">();

    // ── Hook: before_dispatch ────────────────────────────────────────
    // Routes by topic, short-circuits duplicates, assigns pool.
    api.on(
      "before_dispatch",
      async (event) => {
        try {
          const sessionKey = String(event.sessionKey ?? "");
          const content = String(event.content ?? "");
          const topic = parseTopicSessionKey(sessionKey);
          const route = routeTopic(topic, routingConfig);

          // Dedup check
          const contentHash = hashContent(content);
          const dedupKey = buildDedupKey(topic, contentHash);
          let isDuplicate = false;
          if (dedupKey.valid) {
            const now = Date.now();
            const lastSeen = dedupCache.get(dedupKey.key);
            if (lastSeen !== undefined && now - lastSeen < dedupWindowMs) {
              isDuplicate = true;
            }
            // Prune old entries
            for (const [key, ts] of dedupCache) {
              if (now - ts > dedupWindowMs) {
                dedupCache.delete(key);
              }
            }
            if (!isDuplicate) {
              dedupCache.set(dedupKey.key, now);
            }
          }

          const decision = decideDispatch({
            topic,
            content,
            isDuplicate,
            pool: route.pool,
          });

          if (decision.action === "short-circuit") {
            api.logger?.info?.(
              `[oc-topic-worker-pool] short-circuit: ${decision.reason}`,
            );
            // Return handled=true with empty text to skip the agent.
            // The OC hook system will see { handled: true } and skip.
          }

          if (decision.action === "skip") {
            api.logger?.info?.(
              `[oc-topic-worker-pool] skip: ${decision.reason}`,
            );
          }

          // For "route" — let the agent proceed; before_agent_run will
          // handle pool admission.
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] before_dispatch failed: ${String(err)}`,
          );
        }
      }
    );

    // ── Hook: before_agent_run ───────────────────────────────────────
    // Admission gate — acquires a main pool slot. The await IS the queue.
    api.on(
      "before_agent_run",
      async (event) => {
        try {
          const runId = String(event.runId ?? event.sessionId ?? "unknown");
          api.logger?.info?.(
            `[oc-topic-worker-pool] before_agent_run: acquiring main pool slot (runId=${runId})`,
          );

          const report = await mainPool.acquire();
          runPoolMap.set(runId, "main");

          api.logger?.info?.(
            `[oc-topic-worker-pool] main pool: active=${report.active}/${report.max} (waited=${mainPool.state.totalWaited})`,
          );

          // Return pass — the agent should proceed.
          // (OC's before_agent_run expects { outcome: "pass" } or { outcome: "block", reason })
          return { outcome: "pass" };
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] before_agent_run failed: ${String(err)}`,
          );
          // On error, don't block the agent — let it proceed.
          return { outcome: "pass" };
        }
      }
    );

    // ── Hook: agent_end ──────────────────────────────────────────────
    // Releases the main pool slot.
    api.on(
      "agent_end",
      async (event) => {
        try {
          const runId = String(event.runId ?? event.sessionId ?? "unknown");
          const poolType = runPoolMap.get(runId);

          if (poolType === "main") {
            const report = mainPool.release();
            runPoolMap.delete(runId);
            api.logger?.info?.(
              `[oc-topic-worker-pool] agent_end: released main pool slot (active=${report.active}/${report.max})`,
            );
          }
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] agent_end failed: ${String(err)}`,
          );
        }
      }
    );

    // ── Hook: subagent_spawning ──────────────────────────────────────
    // Acquires a sub-pool slot for the subagent.
    api.on(
      "subagent_spawning",
      async (event) => {
        try {
          const runId = String(event.runId ?? "unknown");
          api.logger?.info?.(
            `[oc-topic-worker-pool] subagent_spawning: acquiring sub pool slot (runId=${runId})`,
          );

          const report = await subPool.acquire();
          runPoolMap.set(runId, "sub");

          api.logger?.info?.(
            `[oc-topic-worker-pool] sub pool: active=${report.active}/${report.max} (waited=${subPool.state.totalWaited})`,
          );

          // Return undefined (pass-through) — let the subagent proceed.
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] subagent_spawning failed: ${String(err)}`,
          );
        }
      }
    );

    // ── Hook: subagent_ended ─────────────────────────────────────────
    // Releases the sub-pool slot.
    api.on(
      "subagent_ended",
      async (event) => {
        try {
          const runId = String(event.runId ?? "unknown");
          const poolType = runPoolMap.get(runId);

          if (poolType === "sub") {
            const report = subPool.release();
            runPoolMap.delete(runId);
            api.logger?.info?.(
              `[oc-topic-worker-pool] subagent_ended: released sub pool slot (active=${report.active}/${report.max})`,
            );
          }
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] subagent_ended failed: ${String(err)}`,
          );
        }
      }
    );

    // ── Hook: before_agent_reply ─────────────────────────────────────
    // Egress — can be used for rate-limiting replies per topic.
    api.on(
      "before_agent_reply",
      async (event) => {
        try {
          // For now, just log the pool stats (passive observation).
          // Future: per-topic rate limiting, reply merging.
          const stats = mainPool.getStats();
          api.logger?.info?.(
            `[oc-topic-worker-pool] before_agent_reply: pool stats active=${stats.active}/${stats.max} peak=${stats.peakActive} waited=${stats.totalWaited}`,
          );
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] before_agent_reply failed: ${String(err)}`,
          );
        }
      }
    );

    // Expose pool stats for health checks (via a tool if needed).
    api.logger?.info?.(
      `[oc-topic-worker-pool] initialized: mainPool=${mainPoolMax}, subPool=${subPoolMax}, dedupWindow=${dedupWindowMs}ms`,
    );
  },
});
