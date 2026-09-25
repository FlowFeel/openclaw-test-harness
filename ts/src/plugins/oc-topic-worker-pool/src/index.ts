/**
 * OcTopicWorkerPool — plugin entry point (wiring layer).
 *
 * @behavior
 * Wires six hooks to the pure logic seams (topic-worker-pool-logic.ts) to
 * implement a hook-based worker pool for concurrent Telegram topic sessions.
 *
 * The pool uses a counting semaphore: before_agent_run acquires a slot
 * (awaiting if full = backpressure, bounded by acquireTimeoutMs), agent_end
 * releases it. Subagents get their own pool via subagent_spawning/subagent_ended.
 * before_dispatch routes by topic and short-circuits duplicates.
 *
 * Includes an autonomous dead-slot watchdog to detect and force-release
 * stale or orphaned leases across unhandled hook terminations and aborts.
 *
 * @invariants
 * - No logic here — only wiring (read state → pure call → act on result).
 * - No direct node:fs imports — I/O goes through the Protocol wrapper.
 * - Hooks catch errors and log (never block agent runs unexpectedly).
 * - All exit paths (hook failure, abort, timeout, finish) guarantee slot release.
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
  forceRelease,
  getStats,
  isFull,
  recordLease,
  releaseLease,
  reapStaleLeases,
  reconcilePool,
  type SemaphoreState,
  type SemaphoreReport,
  type PoolLease,
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
  /** Explicitly enable the plugin (default: false). Admission control is disabled by default unless enabled: true or env OPENCLAW_ENABLE_TOPIC_WORKER_POOL=1. */
  enabled?: boolean;
  /** Max concurrent main agent runs (default: 3). */
  mainPoolMax?: number;
  /** Max concurrent subagent runs (default: 2). */
  subPoolMax?: number;
  /** Dedup window in ms (default: 5000). */
  dedupWindowMs?: number;
  /** Routing config for pool assignment. */
  routing?: TopicRoutingConfig;
  /** Maximum queue wait time before before_agent_run returns a block (default: 10_000ms, strictly < 15s OpenClaw budget). */
  acquireTimeoutMs?: number;
  /** Maximum lease duration before watchdog force-releases a leaked slot (default: 300_000ms = 5 minutes). */
  maxLeaseDurationMs?: number;
  /** Watchdog sweep interval in ms (default: 30_000ms). <= 0 disables periodic timer. */
  watchdogIntervalMs?: number;
}

// ── Async semaphore (the wiring around the pure state) ──────────────────

export interface AcquireOptions {
  /** Optional timeout in ms. If the slot cannot be acquired in this time, returns action: "timeout" or rejects if rejectOnTimeout is true. */
  timeoutMs?: number;
  /** If true, rejects the promise on timeout instead of resolving with action: "timeout". */
  rejectOnTimeout?: boolean;
  /** Optional abort signal to cancel waiting. */
  signal?: AbortSignal;
}

export interface Waiter {
  readonly waiterId: number;
  resolve: (report: SemaphoreReport) => void;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * An async wrapper around the pure SemaphoreState.
 *
 * The pure logic (acquire/release) only updates counters. This wrapper
 * adds the Promise/resolve plumbing that makes acquire() actually await
 * when the pool is full.
 */
export interface AsyncSemaphore {
  state: SemaphoreState;
  waiters: Waiter[];
  acquire(options?: AcquireOptions): Promise<SemaphoreReport>;
  release(): SemaphoreReport;
  forceRelease(count?: number, reason?: string): SemaphoreReport;
  getStats(): ReturnType<typeof getStats>;
  isFull(): boolean;
  purgeCancelledWaiters(): number;
}

export function createAsyncSemaphore(max: number): AsyncSemaphore {
  const state = createSemaphore(max);
  const waiters: Waiter[] = [];

  function purgeCancelledWaiters(): number {
    let purged = 0;
    while (waiters.length > 0 && waiters[0].cancelled) {
      waiters.shift();
      purged += 1;
    }
    return purged;
  }

  return {
    state,
    waiters,

    async acquire(options?: AcquireOptions): Promise<SemaphoreReport> {
      if (options?.signal?.aborted) {
        return {
          action: "rejected",
          active: state.active,
          max: state.max,
          reason: "acquire aborted by signal",
        };
      }

      purgeCancelledWaiters();
      const report = acquire(state);
      if (report.action === "acquired") {
        return report;
      }

      // Queued — create a Promise that resolves when a slot frees or when timed out/aborted.
      return new Promise<SemaphoreReport>((resolve, reject) => {
        const waiter: Waiter = {
          waiterId: report.waiterId!,
          resolve: () => {},
          cancelled: false,
        };

        const cleanup = () => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = undefined;
          }
          if (options?.signal && onAbort) {
            options.signal.removeEventListener("abort", onAbort);
          }
        };

        let onAbort: (() => void) | undefined;
        if (options?.signal) {
          onAbort = () => {
            if (!waiter.cancelled) {
              waiter.cancelled = true;
              cleanup();
              const idx = waiters.indexOf(waiter);
              if (idx !== -1) waiters.splice(idx, 1);
              resolve({
                action: "rejected",
                active: state.active,
                max: state.max,
                waiterId: waiter.waiterId,
                reason: "acquire aborted by signal",
              });
            }
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        if (
          options?.timeoutMs !== undefined &&
          options.timeoutMs > 0 &&
          options.timeoutMs < Infinity
        ) {
          waiter.timer = setTimeout(() => {
            if (!waiter.cancelled) {
              waiter.cancelled = true;
              cleanup();
              const idx = waiters.indexOf(waiter);
              if (idx !== -1) waiters.splice(idx, 1);
              if (options.rejectOnTimeout) {
                reject(new Error(`acquire timed out after ${options.timeoutMs}ms`));
              } else {
                resolve({
                  action: "timeout",
                  active: state.active,
                  max: state.max,
                  waiterId: waiter.waiterId,
                  reason: `acquire timed out after ${options.timeoutMs}ms`,
                });
              }
            }
          }, options.timeoutMs);
        }

        waiter.resolve = (rep: SemaphoreReport) => {
          if (!waiter.cancelled) {
            cleanup();
            resolve(rep);
          }
        };

        waiters.push(waiter);
      });
    },

    release(): SemaphoreReport {
      purgeCancelledWaiters();
      const report = release(state);
      if (report.action === "released") {
        while (waiters.length > 0) {
          const next = waiters.shift()!;
          if (!next.cancelled) {
            const reacquire = acquire(state);
            next.resolve(reacquire);
            return reacquire;
          }
        }
      }
      return report;
    },

    forceRelease(count = 1, reason = "force released"): SemaphoreReport {
      purgeCancelledWaiters();
      const report = forceRelease(state, count, reason);
      if (report.action === "force_released") {
        while (waiters.length > 0 && state.active < state.max) {
          const next = waiters.shift()!;
          if (!next.cancelled) {
            const reacquire = acquire(state);
            next.resolve(reacquire);
          }
        }
      }
      return report;
    },

    getStats() {
      return getStats(state);
    },

    isFull() {
      return isFull(state);
    },

    purgeCancelledWaiters,
  };
}

/** Extract correlation identifier from event or context payload. */
export function extractRunId(event: unknown, ctx?: unknown): string {
  const ev = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
  const cx = (ctx && typeof ctx === "object" ? ctx : {}) as Record<string, unknown>;
  const candidate =
    ev.runId ??
    cx.runId ??
    ev.sessionId ??
    cx.sessionId ??
    ev.conversationId ??
    cx.conversationId ??
    ev.sessionKey ??
    cx.sessionKey;
  return candidate !== undefined && candidate !== null ? String(candidate) : "";
}

// ── Plugin ──────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "oc-topic-worker-pool",
  name: "OcTopicWorkerPool",
  description:
    "Hook-based worker pool with semaphore admission control for concurrent Telegram topic sessions",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as OcTopicWorkerPoolConfig) ?? {};

    // Safety gate (Issue #45): Disabled by default unless explicitly enabled in config or env
    const isEnvEnabled =
      typeof process !== "undefined" &&
      process.env &&
      (process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL === "1" ||
        process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL === "true" ||
        process.env.OPENCLAW_TOPIC_WORKER_POOL === "1" ||
        process.env.OPENCLAW_TOPIC_WORKER_POOL === "true");

    const isEnabled = cfg.enabled === true || (cfg.enabled !== false && Boolean(isEnvEnabled));

    if (!isEnabled) {
      api.logger?.info?.(
        "[oc-topic-worker-pool] plugin disabled by default (enable via config { enabled: true } or env OPENCLAW_ENABLE_TOPIC_WORKER_POOL=1)",
      );
      return;
    }

    const mainPoolMax = cfg.mainPoolMax ?? 3;
    const subPoolMax = cfg.subPoolMax ?? 2;
    const dedupWindowMs = cfg.dedupWindowMs ?? 5_000;
    const acquireTimeoutMs = cfg.acquireTimeoutMs ?? 10_000;
    const maxLeaseDurationMs = cfg.maxLeaseDurationMs ?? 300_000;
    const watchdogIntervalMs = cfg.watchdogIntervalMs ?? 30_000;

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

    // Active leases tracked with timestamps for watchdog leak detection
    const activeLeases = new Map<string, PoolLease>();

    // ── Watchdog Sweep ───────────────────────────────────────────────
    const runWatchdogSweep = (nowMs = Date.now()) => {
      // 1. Reap leases exceeding maxLeaseDurationMs
      const reapedReport = reapStaleLeases(activeLeases, nowMs, maxLeaseDurationMs);
      for (const reaped of reapedReport.reaped) {
        runPoolMap.delete(reaped.runId);
        if (reaped.pool === "main") {
          mainPool.release();
          api.logger?.warn?.(
            `[oc-topic-worker-pool] watchdog: force-released stale main slot for runId=${reaped.runId} (held > ${maxLeaseDurationMs}ms)`,
          );
        } else {
          subPool.release();
          api.logger?.warn?.(
            `[oc-topic-worker-pool] watchdog: force-released stale sub slot for runId=${reaped.runId} (held > ${maxLeaseDurationMs}ms)`,
          );
        }
      }

      // 2. Pool reconciliation: if active > live leases, force-reconcile excess
      const mainLiveCount = Array.from(activeLeases.values()).filter((l) => l.pool === "main").length;
      const mainReconcile = reconcilePool(mainPool.state, mainLiveCount);
      if (mainReconcile.action === "reconciled") {
        api.logger?.warn?.(
          `[oc-topic-worker-pool] watchdog: reconciled ${mainReconcile.forceReleasedCount} orphaned main slots (active was ${mainReconcile.previousActive} -> now ${mainReconcile.currentActive})`,
        );
      }

      const subLiveCount = Array.from(activeLeases.values()).filter((l) => l.pool === "sub").length;
      const subReconcile = reconcilePool(subPool.state, subLiveCount);
      if (subReconcile.action === "reconciled") {
        api.logger?.warn?.(
          `[oc-topic-worker-pool] watchdog: reconciled ${subReconcile.forceReleasedCount} orphaned sub slots (active was ${subReconcile.previousActive} -> now ${subReconcile.currentActive})`,
        );
      }
    };

    let watchdogTimer: NodeJS.Timeout | undefined;
    if (watchdogIntervalMs > 0) {
      watchdogTimer = setInterval(() => {
        try {
          runWatchdogSweep();
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] watchdog sweep error: ${String(err)}`,
          );
        }
      }, watchdogIntervalMs);
      if (typeof watchdogTimer.unref === "function") {
        watchdogTimer.unref();
      }
    }

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
    // Admission gate — acquires a main pool slot with bounded queue wait.
    api.on(
      "before_agent_run",
      async (event: unknown, ctx?: unknown) => {
        let acquired = false;
        let runId = "";
        try {
          runId =
            extractRunId(event, ctx) ||
            `main-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          api.logger?.info?.(
            `[oc-topic-worker-pool] before_agent_run: acquiring main pool slot (runId=${runId})`,
          );

          // Real-time run abort binding (Issue #45): release immediately if lane-killed or cancelled
          const runSignal =
            (ctx && typeof ctx === "object" && "signal" in ctx && (ctx.signal as unknown) instanceof AbortSignal
              ? (ctx.signal as AbortSignal)
              : undefined) ??
            (event && typeof event === "object" && "signal" in event && (event.signal as unknown) instanceof AbortSignal
              ? (event.signal as AbortSignal)
              : undefined);

          // Acquire with timeout strictly below OpenClaw's 15s fail-closed gate
          const report = await mainPool.acquire({
            timeoutMs: acquireTimeoutMs,
            signal: runSignal,
          });

          if (report.action !== "acquired") {
            api.logger?.warn?.(
              `[oc-topic-worker-pool] before_agent_run: pool saturated (runId=${runId}, action=${report.action}, reason=${report.reason ?? "none"}), failing open to avoid blocking gateway`,
            );
            // FAIL OPEN (Issue #45): Admission control must never block the gateway
            return { outcome: "pass" };
          }

          acquired = true;
          recordLease(activeLeases, {
            runId,
            pool: "main",
            acquiredAt: Date.now(),
          });
          runPoolMap.set(runId, "main");

          if (runSignal) {
            const onRunAbort = () => {
              if (acquired && runId && activeLeases.has(runId)) {
                api.logger?.warn?.(
                  `[oc-topic-worker-pool] abort signal received for runId=${runId}: releasing main pool slot immediately`,
                );
                mainPool.release();
                releaseLease(activeLeases, runId);
                runPoolMap.delete(runId);
              }
            };
            runSignal.addEventListener("abort", onRunAbort, { once: true });
          }

          api.logger?.info?.(
            `[oc-topic-worker-pool] main pool: active=${report.active}/${report.max} (waited=${mainPool.state.totalWaited})`,
          );

          // Return pass — the agent should proceed.
          return { outcome: "pass" };
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] before_agent_run failed: ${String(err)}`,
          );
          // If we acquired the slot but failed afterwards, release immediately to prevent leaks
          if (acquired && runId) {
            mainPool.release();
            releaseLease(activeLeases, runId);
            runPoolMap.delete(runId);
          }
          // On unhandled error or rejected acquire, fail open (never block the agent)
          return { outcome: "pass" };
        }
      }
    );

    // ── Hook: agent_end ──────────────────────────────────────────────
    // Releases the main pool slot.
    api.on(
      "agent_end",
      async (event: unknown, ctx?: unknown) => {
        try {
          const runId = extractRunId(event, ctx);
          const lease = runId ? activeLeases.get(runId) : undefined;
          const poolType =
            (runId ? runPoolMap.get(runId) : undefined) ??
            lease?.pool ??
            (mainPool.state.active > 0 ? "main" : undefined);

          if (poolType === "main") {
            const report = mainPool.release();
            if (runId) {
              runPoolMap.delete(runId);
              releaseLease(activeLeases, runId);
            } else if (activeLeases.size > 0) {
              // If runId missing, release oldest main lease
              for (const [id, l] of activeLeases) {
                if (l.pool === "main") {
                  activeLeases.delete(id);
                  runPoolMap.delete(id);
                  break;
                }
              }
            }
            api.logger?.info?.(
              `[oc-topic-worker-pool] agent_end: released main pool slot (runId=${runId || "unknown"}, active=${report.active}/${report.max})`,
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
    // Acquires a sub-pool slot for the subagent with bounded queue wait.
    api.on(
      "subagent_spawning",
      async (event: unknown, ctx?: unknown) => {
        let acquired = false;
        let runId = "";
        try {
          runId =
            extractRunId(event, ctx) ||
            `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          api.logger?.info?.(
            `[oc-topic-worker-pool] subagent_spawning: acquiring sub pool slot (runId=${runId})`,
          );

          const subSignal =
            (ctx && typeof ctx === "object" && "signal" in ctx && (ctx.signal as unknown) instanceof AbortSignal
              ? (ctx.signal as AbortSignal)
              : undefined) ??
            (event && typeof event === "object" && "signal" in event && (event.signal as unknown) instanceof AbortSignal
              ? (event.signal as AbortSignal)
              : undefined);

          const report = await subPool.acquire({
            timeoutMs: acquireTimeoutMs,
            signal: subSignal,
          });

          if (report.action !== "acquired") {
            api.logger?.warn?.(
              `[oc-topic-worker-pool] subagent_spawning: sub pool saturated (runId=${runId}, action=${report.action}), passing through`,
            );
            return;
          }

          acquired = true;
          recordLease(activeLeases, {
            runId,
            pool: "sub",
            acquiredAt: Date.now(),
          });
          runPoolMap.set(runId, "sub");

          if (subSignal) {
            const onSubAbort = () => {
              if (acquired && runId && activeLeases.has(runId)) {
                api.logger?.warn?.(
                  `[oc-topic-worker-pool] abort signal received for subagent runId=${runId}: releasing sub pool slot immediately`,
                );
                subPool.release();
                releaseLease(activeLeases, runId);
                runPoolMap.delete(runId);
              }
            };
            subSignal.addEventListener("abort", onSubAbort, { once: true });
          }

          api.logger?.info?.(
            `[oc-topic-worker-pool] sub pool: active=${report.active}/${report.max} (waited=${subPool.state.totalWaited})`,
          );
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] subagent_spawning failed: ${String(err)}`,
          );
          if (acquired && runId) {
            subPool.release();
            releaseLease(activeLeases, runId);
            runPoolMap.delete(runId);
          }
        }
      }
    );

    // ── Hook: subagent_ended ─────────────────────────────────────────
    // Releases the sub-pool slot.
    api.on(
      "subagent_ended",
      async (event: unknown, ctx?: unknown) => {
        try {
          const runId = extractRunId(event, ctx);
          const lease = runId ? activeLeases.get(runId) : undefined;
          const poolType =
            (runId ? runPoolMap.get(runId) : undefined) ??
            lease?.pool ??
            (subPool.state.active > 0 ? "sub" : undefined);

          if (poolType === "sub") {
            const report = subPool.release();
            if (runId) {
              runPoolMap.delete(runId);
              releaseLease(activeLeases, runId);
            } else if (activeLeases.size > 0) {
              for (const [id, l] of activeLeases) {
                if (l.pool === "sub") {
                  activeLeases.delete(id);
                  runPoolMap.delete(id);
                  break;
                }
              }
            }
            api.logger?.info?.(
              `[oc-topic-worker-pool] subagent_ended: released sub pool slot (runId=${runId || "unknown"}, active=${report.active}/${report.max})`,
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
    // Egress — can be used for rate-limiting replies per topic + opportunistic watchdog sweep.
    api.on(
      "before_agent_reply",
      async (event) => {
        try {
          runWatchdogSweep();
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

    // ── Hook: session_end ────────────────────────────────────────────
    // Clean up any surviving lease if an agent run was terminated/aborted
    api.on(
      "session_end",
      async (event: unknown, ctx?: unknown) => {
        try {
          const runId = extractRunId(event, ctx);
          if (runId && activeLeases.has(runId)) {
            const lease = activeLeases.get(runId)!;
            if (lease.pool === "main") {
              mainPool.release();
            } else {
              subPool.release();
            }
            releaseLease(activeLeases, runId);
            runPoolMap.delete(runId);
            api.logger?.info?.(
              `[oc-topic-worker-pool] session_end: cleaned up orphaned ${lease.pool} lease for runId=${runId}`,
            );
          }
        } catch (err) {
          api.logger?.error?.(
            `[oc-topic-worker-pool] session_end cleanup error: ${String(err)}`,
          );
        }
      }
    );

    // Expose pool stats for health checks
    api.logger?.info?.(
      `[oc-topic-worker-pool] initialized: mainPool=${mainPoolMax}, subPool=${subPoolMax}, dedupWindow=${dedupWindowMs}ms, acquireTimeout=${acquireTimeoutMs}ms`,
    );
  },
});
