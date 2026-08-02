/**
 * FairPool — per-topic fair scheduling & backpressure on top of a WorkerPool
 * (ticket #14).
 *
 * @behavior
 * Wraps an inner WorkerPool (Mock for tests, Piscina for prod) and adds per-
 * topic fairness: tasks submitted via executeForTopic(topic, ...) enter per-
 * topic queues, and a round-robin dispatcher (pickNextTopic, the pure seam)
 * interleaves them so no single topic's burst starves sibling topics. Tasks
 * submitted via execute(handler, input) — no topic — go straight to the inner
 * pool (backward compatible; the WorkerPool Protocol is unchanged).
 *
 * FairPool is its own concurrency gate: it tracks inFlight and only dispatches
 * while inFlight < maxConcurrent. This makes FairPool the scheduling bottleneck
 * (not the inner pool's FIFO queue), so the round-robin order is the observable,
 * deterministic fairness guarantee. In prod, maxConcurrent should equal the
 * inner pool's thread count so FairPool schedules and the inner pool executes.
 *
 * Backpressure: backpressure(topic) returns a BackpressureResult (via the pure
 * evaluateBackpressure) the admission layer reads to admit or reject that
 * topic's spawns. Per-topic — one topic's flood does not pressure a sibling.
 *
 * @invariants
 * - Implements WorkerPool (Protocol compliance — acceptance #3): register,
 *   execute, stats, drain, destroy all delegate/overlay correctly. The existing
 *   worker-pool spec suite passes against FairPool unchanged (FairPool honors
 *   the same contract as MockWorkerPool).
 * - Every dispatch decision goes through pickNextTopic (pure). FairPool never
 *   invents the next topic — it applies the pure scheduler to its queue state.
 * - Every backpressure decision goes through evaluateBackpressure (pure).
 * - drain() waits for all queued + in-flight to settle (no leaked promises).
 * - destroy() rejects pending queued tasks (no leaked promises) + inner.destroy().
 *
 * @remarks
 * The fairness guarantee is a DISPATCH ORDER, not a latency bound: under flood,
 * a sibling topic's task is dispatched before the flooding topic's backlog
 * (round-robin interleaves), proven by exact completion order — not "P99 ≤ 2×"
 * (wall-clock is a non-deterministic sanity check, never the load-bearing claim).
 */

import type {
  WorkerPool,
  WorkerResult,
  PoolStats,
  HandlerRegistry,
} from "./worker-pool.schema.js"
import { pickNextTopic, evaluateBackpressure, type BackpressureResult } from "./fair-scheduler.js"

export interface FairPoolOptions {
  /** Max tasks dispatched to the inner pool at once. FairPool is the scheduling
   * bottleneck, so this should be ≤ the inner pool's thread count. Default 4. */
  maxConcurrent?: number
  /** Per-topic queue depth that flips backpressure on (strict >). Default 8. */
  backpressureThreshold?: number
}

interface FairTask {
  handler: string
  input: unknown
  resolve: (r: WorkerResult) => void
  reject: (e: Error) => void
}

export class FairPool implements WorkerPool {
  private readonly inner: WorkerPool
  private readonly maxConcurrent: number
  private readonly backpressureThreshold: number
  private readonly queues = new Map<string, FairTask[]>()
  private inFlight = 0
  private cursor: string | null = null
  private destroyed = false
  private completedTasks = 0
  private failedTasks = 0

  constructor(inner: WorkerPool, opts: FairPoolOptions = {}) {
    this.inner = inner
    this.maxConcurrent = opts.maxConcurrent ?? 4
    this.backpressureThreshold = opts.backpressureThreshold ?? 8
  }

  // ── WorkerPool Protocol (delegates to inner; backward compatible) ──────

  register(name: string, handler: (...args: any[]) => unknown): void {
    this.inner.register(name, handler)
  }

  /** No-topic execute: straight to the inner pool (no fairness, backward
   * compatible). The Protocol surface is unchanged. */
  async execute<T>(
    handler: string,
    input: unknown,
  ): Promise<WorkerResult & { data?: T }> {
    return this.inner.execute<T>(handler, input)
  }

  stats(): PoolStats {
    const inner = this.inner.stats()
    let queued = 0
    for (const q of this.queues.values()) queued += q.length
    return {
      ...inner,
      queuedTasks: queued,
      activeThreads: this.inFlight,
      completedTasks: this.completedTasks + inner.completedTasks,
      failedTasks: this.failedTasks + inner.failedTasks,
    }
  }

  async drain(): Promise<void> {
    // Wait for all queued + in-flight to settle. Poll: the inner pool's .then
    // callbacks decrement inFlight and re-pump, so once queues are empty AND
    // inFlight === 0, everything has resolved. setImmediate yields between polls
    // so the inner pool's microtasks drain.
    while (this.queues.size > 0 || this.inFlight > 0) {
      await new Promise((r) => setImmediate(r))
    }
    await this.inner.drain()
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    // Reject every pending queued task — no leaked promises. (Rejections carry
    // "pool destroyed" so callers see a deterministic reason.)
    for (const q of this.queues.values()) {
      for (const t of q) t.reject(new Error("pool destroyed"))
    }
    this.queues.clear()
    await this.inner.destroy()
  }

  // ── The fairness surface (#14) ──────────────────────────────────────

  /**
   * Execute a task on behalf of a topic. The task enters that topic's queue and
   * is dispatched by the round-robin scheduler, so a flooding topic cannot
   * starve sibling topics. Returns the same WorkerResult shape as execute().
   */
  executeForTopic<T>(
    topic: string,
    handler: string,
    input: unknown,
  ): Promise<WorkerResult & { data?: T }> {
    return new Promise<WorkerResult & { data?: T }>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("pool destroyed"))
        return
      }
      // T is erased in the heterogeneous queue — the runtime value carries data,
      // the type just cannot track per-task T. The cast is the standard escape
      // hatch for typed promise queues (same pattern as any task scheduler).
      this.enqueue(topic, { handler, input, resolve: resolve as (r: WorkerResult) => void, reject })
      this.pump()
    })
  }

  /**
   * Per-topic backpressure signal for the admission layer. Pure underneath:
   * evaluateBackpressure(depth, threshold). One topic's flood does not pressure
   * a sibling — the query is scoped to the named topic.
   */
  backpressure(topic: string): BackpressureResult {
    return evaluateBackpressure(this.queues.get(topic)?.length ?? 0, this.backpressureThreshold)
  }

  // ── Internals ──────────────────────────────────────────────────────

  private enqueue(topic: string, task: FairTask): void {
    let q = this.queues.get(topic)
    if (!q) {
      q = []
      this.queues.set(topic, q)
    }
    q.push(task)
  }

  /** Dispatch queued tasks to the inner pool while capacity permits, in round-
   * robin topic order (via the pure pickNextTopic). Re-invoked after each task
   * completes, so the rotation advances on every free slot. */
  private pump(): void {
    while (this.inFlight < this.maxConcurrent && !this.destroyed) {
      const nonEmpty = [...this.queues.entries()]
        .filter(([, q]) => q.length > 0)
        .map(([t]) => t)
      const topic = pickNextTopic(nonEmpty, this.cursor)
      if (!topic) break
      this.cursor = topic
      const q = this.queues.get(topic)!
      const task = q.shift()!
      if (q.length === 0) this.queues.delete(topic)
      this.inFlight++
      // Dispatch to the inner pool. On completion: account, resolve the caller,
      // and re-pump so the next queued task (fairly chosen) fills the freed slot.
      void this.inner
        .execute(task.handler, task.input)
        .then((result) => {
          this.inFlight--
          if (result.ok) this.completedTasks++
          else this.failedTasks++
          task.resolve(result)
          this.pump()
        })
        .catch((err) => {
          this.inFlight--
          this.failedTasks++
          task.reject(err instanceof Error ? err : new Error(String(err)))
          this.pump()
        })
    }
  }
}
