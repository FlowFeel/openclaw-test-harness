/**
 * Piscina worker pool — production WorkerPool Protocol implementation (ticket #12).
 *
 * This is the production transport for the WorkerPool Protocol: it offloads
 * CPU-heavy handler work onto real worker_threads via Piscina. Before #12,
 * execute() called fn(input) inline on the main thread — it used NO
 * worker_threads, so prod was functionally identical to MockWorkerPool and the
 * Protocol abstraction was undermined (swapping implementations changed nothing
 * about execution). #12 wires Piscina for real.
 *
 * @behavior
 * - Lazy-initializes the Piscina pool on first execute() (workers spawn on demand).
 * - The handler registry is serialized into a CJS worker file via
 *   Function.prototype.toString — the #11 seam. Purity is what makes this work:
 *   every handler is a closure-free pure function, so its serialized body
 *   reconstructs faithfully in the worker realm. This is the same technique the
 *   patched worker-pool.js uses (#11), so PiscinaWorkerPool and the patch share
 *   one registry by construction (asserted by conformance in the #12 spec).
 * - execute() posts { handler, input } to Piscina; the worker dispatches.
 * - register() bakes a handler into the worker file, so it must be called
 *   BEFORE first execute() (the worker file is baked at init). A post-init
 *   register() throws honestly rather than silently no-op'ing — the pre-#12
 *   register() stored handlers in a Map that execute() never read.
 *
 * @invariants
 * - Pool size is pinned: minThreads === maxThreads (no idle teardown mid-run),
 *   matching the patched worker-pool.js which holds MAX_THREADS permanently.
 *   This keeps stats().poolSize stable and deterministic for tests.
 * - Workers are reused across tasks (no spawn-per-task overhead).
 * - A handler error in one task rejects that task's promise only; Piscina
 *   isolates tasks. (Worker *crash* isolation & respawn is the patch's #13
 *   concern; Piscina manages its own thread lifecycle here.)
 * - The Protocol contract is preserved: execute() returns WorkerResult
 *   ({ ok, data?, error?, durationMs }) and never throws — errors map to
 *   { ok: false, error }, matching MockWorkerPool.
 *
 * @remarks
 * Piscina workers are real files (Piscina cannot eval a string source the way
 * worker_threads can). The worker file is written to tmpdir() once per instance
 * with a unique name (pid + uuid) so parallel test processes don't collide.
 * workerData cannot carry the registry because functions are not
 * structured-cloneable — Function.prototype.toString is the only seam, and it
 * is exactly the #11 purity-enabling seam.
 */

import { Piscina } from "piscina"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { cpus } from "node:os"
import { randomUUID } from "node:crypto"
import type { PoolStats, WorkerPool, WorkerResult, HandlerRegistry } from "./worker-pool.schema.js"
import { registerBuiltinHandlers } from "./handlers.js"

export interface PiscinaPoolOptions {
  /**
   * Handler registry to bake into the worker. Defaults to the built-in pure
   * handlers from handlers.ts. The #12 conformance spec constructs the pool
   * with the patched worker-pool.js `handlers` object, so the Piscina worker
   * runs the patch's handler code verbatim — one registry, two surfaces.
   */
  handlers?: Record<string, (input: any) => unknown>
  /** Max worker threads. Defaults to CPU count - 1 (leave one core for main). */
  maxThreads?: number
}

export class PiscinaWorkerPool implements WorkerPool {
  private pool: Piscina | null = null
  private handlers: HandlerRegistry = new Map()
  private readonly maxThreads: number
  private destroyed = false
  private activeTasks = 0

  private stats_: PoolStats = {
    activeThreads: 0,
    queuedTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    averageDurationMs: 0,
    poolSize: 0,
  }
  private durations: number[] = []

  constructor(options: PiscinaPoolOptions = {}) {
    this.maxThreads = options.maxThreads ?? Math.max(1, cpus().length - 1)

    if (options.handlers) {
      // Caller-supplied registry (e.g. the patch's `handlers` for conformance).
      for (const [name, fn] of Object.entries(options.handlers)) {
        this.handlers.set(name, fn)
      }
    } else {
      // Default: the built-in pure handlers (json.stringify, compact.context,
      // serialize.session, ipc.transfer, fanout.topics). registerBuiltinHandlers
      // calls this.register(), which is legal pre-init (pool is still null).
      registerBuiltinHandlers(this)
    }
  }

  register(name: string, handler: (...args: any[]) => unknown): void {
    // Handlers are baked into the worker file at pool-init time (Function.prototype.
    // toString round-trips them into the CJS worker). A post-init register() cannot
    // reach the already-spawned workers, so it throws honestly — the pre-#12
    // register() silently stored handlers in a Map that execute() never read.
    if (this.destroyed) {
      throw new Error("Cannot register on a destroyed pool")
    }
    if (this.pool) {
      throw new Error(
        "Cannot register after the pool is initialized — handlers are baked into the worker file at init time; register before the first execute()",
      )
    }
    this.handlers.set(name, handler)
  }

  async execute<T>(
    handler: string,
    input: unknown,
  ): Promise<WorkerResult & { data?: T }> {
    // Destroyed pool: refuse before touching the registry (handlers are cleared
    // on destroy, so the registry check below would misreport "not registered").
    if (this.destroyed) {
      return { ok: false, error: "Pool destroyed", durationMs: 0 }
    }

    // Unregistered handler: reject before round-tripping to Piscina — no worker
    // spawn. The message is IDENTICAL to the worker's dispatch throw
    // ('Unknown handler: <name>') so the pool-level fast path and the worker-
    // level dispatch path share one error identity — the #11 no-drift principle.
    // (MockWorkerPool keeps its own 'Handler not registered' message; that's the
    // inline test double, not the conformance-targeted production transport.)
    if (!this.handlers.has(handler)) {
      return { ok: false, error: `Unknown handler: ${handler}`, durationMs: 0 }
    }

    const pool = this.ensurePool()
    const start = Date.now()
    this.activeTasks++

    try {
      // Post { handler, input } to Piscina. The worker dispatches via the same
      // registry serialized into its file — real worker_threads execution.
      const data = (await pool.run({ handler, input })) as T
      const durationMs = Date.now() - start
      this.durations.push(durationMs)
      this.stats_.completedTasks++
      this.stats_.averageDurationMs = this.avgDuration()
      return { ok: true, data, durationMs }
    } catch (e) {
      const durationMs = Date.now() - start
      this.durations.push(durationMs)
      this.stats_.failedTasks++
      this.stats_.averageDurationMs = this.avgDuration()
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs,
      }
    } finally {
      this.activeTasks--
    }
  }

  stats(): PoolStats {
    if (this.pool) {
      // Overlay live thread/queue counts from Piscina; completed/failed/avg are
      // tracked locally (consistent with MockWorkerPool's accounting).
      this.stats_.poolSize = this.pool.threads.length
      this.stats_.activeThreads = this.pool.threads.length - this.pool.idleThreads
      this.stats_.queuedTasks = this.pool.queueSize
    }
    return { ...this.stats_ }
  }

  async drain(): Promise<void> {
    // Wait for in-flight tasks to settle WITHOUT closing the pool (the Protocol
    // distinguishes drain = "wait" from destroy = "terminate"). activeTasks is
    // decremented in execute()'s finally, after completedTasks is incremented,
    // so once activeTasks === 0 the local stats are settled. setImmediate yields
    // to let execute() continuations (microtasks) drain between polls.
    if (!this.pool) return
    while (this.activeTasks > 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    if (this.pool) {
      await this.pool.destroy()
      this.pool = null
    }
    this.handlers.clear()
    this.stats_.activeThreads = 0
    this.stats_.queuedTasks = 0
    this.stats_.poolSize = 0
  }

  // ── Internals ──────────────────────────────────────────────

  private ensurePool(): Piscina {
    if (this.pool) return this.pool
    const workerPath = this.writeWorkerModule()
    this.pool = new Piscina({
      filename: workerPath,
      maxThreads: this.maxThreads,
      minThreads: this.maxThreads, // pin thread count — no idle teardown mid-run
    })
    this.stats_.poolSize = this.maxThreads
    return this.pool
  }

  /**
   * Serialize the handler registry into a CJS worker file via
   * Function.prototype.toString (the #11 seam). The worker exports a single
   * task function: (task) => dispatch(task.handler, task.input). Piscina calls
   * it with each task; the return value (or thrown error) is the result.
   *
   * Functions are not structured-cloneable, so workerData cannot carry the
   * registry — toString is the only seam, and it works because every handler is
   * closure-free pure (the #11 invariant).
   */
  private writeWorkerModule(): string {
    const dir = join(tmpdir(), "oc-piscina-pool")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `worker-${process.pid}-${randomUUID().slice(0, 8)}.cjs`)

    const handlersSrc = [...this.handlers.entries()]
      .map(([name, fn]) => `  ${JSON.stringify(name)}: ${fn.toString()}`)
      .join(",\n")

    const src = `'use strict';
// Auto-generated by PiscinaWorkerPool (ticket #12). The handler registry is
// serialized here via Function.prototype.toString — the #11 seam — so the worker
// thread runs the exact same handler logic as the inline dispatch path.
const handlers = {
${handlersSrc}
};
function dispatch(handler, input) {
  const fn = handlers[handler];
  if (typeof fn !== 'function') throw new Error('Unknown handler: ' + handler);
  return fn(input);
}
module.exports = function piscinaWorkerTask(task) {
  return dispatch(task.handler, task.input);
};
`
    writeFileSync(path, src)
    return path
  }

  private avgDuration(): number {
    if (this.durations.length === 0) return 0
    const sum = this.durations.reduce((a, b) => a + b, 0)
    return Math.round(sum / this.durations.length)
  }
}
