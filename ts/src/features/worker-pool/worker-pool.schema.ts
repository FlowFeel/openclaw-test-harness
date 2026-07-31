/**
 * Piscina worker bridge — orthogonal, testable, function-agnostic.
 *
 * @behavior
 * Provides a generic worker thread pool that any function can use to
 * offload CPU-heavy work from the main event loop. Not tied to JSON
 * serialization — works with any serializable input/output.
 *
 * @invariants
 * - The pool is lazy-initialized — no threads created until first use.
 * - Worker code is isolated — errors in one worker don't crash others.
 * - The interface is Protocol-based — tests can swap a mock pool
 *   without touching Piscina.
 * - Cancellation is supported — callers can abort in-flight work.
 *
 * @remarks
 * Piscina is the Node.js standard for worker thread pools. We wrap it
 * in a Protocol so:
 * 1. Tests use a MockWorkerPool (no threads, synchronous, 0ms)
 * 2. Production uses PiscinaWorkerPool (real threads, real parallelism)
 * 3. Other transports (Temporal activities, sidecar processes) can
 *    implement the same Protocol — the calling code doesn't change.
 *
 * The key design decision: the pool is orthogonal to the function being
 * executed. JSON.stringify, context compaction, image processing,
 * PDF generation — all use the same pool. The caller provides:
 * - A worker entry point (file path or function reference)
 * - Input data (must be structured-cloneable)
 * - Optional cancellation signal
 *
 * The pool returns a Promise that resolves to the worker's output.
 */

import { Schema } from "effect"

// ── Worker task schema ─────────────────────────────────────────

export const WorkerTask = Schema.Struct({
  /** Worker entry point — file path or registered function name */
  handler: Schema.String,
  /** Input data — must be structured-cloneable (no functions, no DOM) */
  input: Schema.Unknown,
  /** Optional timeout in ms — aborts the worker if exceeded */
  timeoutMs: Schema.optional(Schema.Number),
  /** Optional priority — higher runs first (0 = default) */
  priority: Schema.optional(Schema.Number),
})
export type WorkerTask = Schema.Schema.Type<typeof WorkerTask>

export const WorkerResult = Schema.Struct({
  ok: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  durationMs: Schema.Number,
})
export type WorkerResult = Schema.Schema.Type<typeof WorkerResult>

// ── Worker pool Protocol ────────────────────────────────────────

/**
 * Protocol for worker thread pools.
 *
 * Implementations:
 * - PiscinaWorkerPool — production (real threads)
 * - MockWorkerPool — tests (synchronous, no threads)
 * - SidecarWorkerPool — future (external process via IPC)
 */
export interface WorkerPool {
  /**
   * Execute a task in the worker pool.
   *
   * @param handler - Worker entry point (file path or registered name).
   * @param input - Input data (must be structured-cloneable).
   * @returns Promise resolving to the worker result.
   */
  execute<T>(
    handler: string,
    input: unknown,
  ): Promise<WorkerResult & { data?: T }>

  /**
   * Register a function handler by name.
   * Workers can call this function without knowing its file path.
   */
  register(name: string, handler: (...args: any[]) => unknown): void

  /**
   * Get pool statistics.
   */
  stats(): PoolStats

  /**
   * Drain the pool — wait for all tasks to complete.
   */
  drain(): Promise<void>

  /**
   * Destroy the pool — terminate all workers.
   */
  destroy(): Promise<void>
}

export interface PoolStats {
  activeThreads: number
  queuedTasks: number
  completedTasks: number
  failedTasks: number
  averageDurationMs: number
  poolSize: number
}

// ── Signal-based cancellation ───────────────────────────────────

/**
 * Cancellation signal — callers can abort in-flight work.
 *
 * Usage:
 *   const cancel = defineSignal()
 *   pool.execute("json/stringify", { data, cancel })
 *   // later:
 *   cancel() // aborts the worker
 */
/**
 * Cancellation signal — a function that aborts in-flight work.
 * Call it to cancel the worker.
 */
export type CancellationSignal = () => void

// ── Registered handlers ─────────────────────────────────────────

/**
 * Registry of named functions that can be executed in workers.
 * This decouples the caller from the worker file path.
 *
 * Usage:
 *   pool.register("json.stringify", (data) => JSON.stringify(data))
 *   pool.register("compact.context", (data) => compactContext(data))
 *   const result = await pool.execute("json.stringify", { data: largeObject })
 */
export type HandlerRegistry = Map<string, (...args: any[]) => unknown>
