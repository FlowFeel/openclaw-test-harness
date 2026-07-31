/**
 * Mock worker pool — for tests, no threads, synchronous, 0ms.
 *
 * Implements WorkerPool Protocol. Runs handlers inline (no thread overhead).
 * Useful for unit tests where you want to verify logic, not parallelism.
 */

import type { PoolStats, WorkerPool, WorkerResult, HandlerRegistry } from "./worker-pool.schema.js"

export class MockWorkerPool implements WorkerPool {
  private handlers: HandlerRegistry = new Map()
  private stats_: PoolStats = {
    activeThreads: 0,
    queuedTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    averageDurationMs: 0,
    poolSize: 0,
  }
  private durations: number[] = []

  register(name: string, handler: (...args: any[]) => unknown): void {
    this.handlers.set(name, handler)
  }

  async execute<T>(
    handler: string,
    input: unknown,
  ): Promise<WorkerResult & { data?: T }> {
    const fn = this.handlers.get(handler)
    if (!fn) {
      return {
        ok: false,
        error: `Handler not registered: ${handler}`,
        durationMs: 0,
      }
    }

    this.stats_.queuedTasks++
    const start = Date.now()

    try {
      const data = fn(input)
      const durationMs = Date.now() - start
      this.durations.push(durationMs)

      this.stats_.queuedTasks--
      this.stats_.completedTasks++
      this.stats_.averageDurationMs = this.avgDuration()

      return { ok: true, data: data as T, durationMs }
    } catch (e) {
      const durationMs = Date.now() - start
      this.stats_.queuedTasks--
      this.stats_.failedTasks++
      this.stats_.averageDurationMs = this.avgDuration()

      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        durationMs,
      }
    }
  }

  stats(): PoolStats {
    return { ...this.stats_ }
  }

  async drain(): Promise<void> {
    // Mock is synchronous — nothing to drain
  }

  async destroy(): Promise<void> {
    this.handlers.clear()
    this.stats_ = {
      activeThreads: 0,
      queuedTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      averageDurationMs: 0,
      poolSize: 0,
    }
  }

  private avgDuration(): number {
    if (this.durations.length === 0) return 0
    const sum = this.durations.reduce((a, b) => a + b, 0)
    return Math.round(sum / this.durations.length)
  }
}
