/**
 * TelemetryCollector — real process telemetry for #17 (live telemetry → admission).
 *
 * @behavior
 * Reads REAL runtime signals — `perf_hooks.monitorEventLoopDelay` (event-loop
 * P99), `performance.eventLoopUtilization()` (utilization), `v8.getHeapStatistics`
 * (used heap, #9's approach), `process.cpuUsage` (CPU core ratio) — and produces
 * `ProcessTelemetry` readings. `collectAndAggregate()` feeds them through the
 * pure `aggregateSystemHealth` into the `SystemHealth` the admission layer
 * (`evaluateAdaptiveSpawn`) reads. Admission decisions now react to REAL
 * pressure, not fixtures.
 *
 * @invariants
 * - Every reading is a REAL signal from the runtime — never a fixture. The
 *   deterministic proof: `usedHeapSize > 0` (the process always has a heap).
 * - `collect(actorId)` is per-actor attributable (#17 acceptance #2) — the
 *   actorId travels with the reading into the aggregation.
 * - The histogram is enabled on construction and disabled on `stop()` — no
 *   leaked perf hooks.
 *
 * @remarks
 * In a fully-realized #17, each supervised actor (#16 TopicRouter) would report
 * its OWN telemetry (each worker thread has its own event loop + heap). The
 * collector here reads the MAIN process (router) telemetry as the authoritative
 * reading; per-actor worker telemetry is the documented extension (workers post
 * their readings via the RPC channel #16 established). The pure
 * `aggregateSystemHealth` handles any set of per-actor readings — the collector
 * is the source, the aggregation is the seam.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { getHeapStatistics } from "node:v8"
import process from "node:process"
import { aggregateSystemHealth, type ProcessTelemetry } from "./telemetry-logic.js"
import type { SystemHealth } from "../subagent-admission/subagent-reporting.schema.js"

export class TelemetryCollector {
  private readonly histogram = monitorEventLoopDelay()
  private lastCpu = process.cpuUsage()
  private lastTime = process.hrtime.bigint()

  constructor() {
    // Enable the histogram so it begins sampling event-loop delay. Disabled on
    // stop() to avoid a leaked perf hook.
    this.histogram.enable()
  }

  /**
   * Collect one real telemetry reading for an actor. Every field is a live
   * signal from the runtime — `usedHeapSize > 0` is the deterministic proof.
   */
  collect(actorId: string): ProcessTelemetry {
    // Event-loop P99 latency: histogram.percentile(99) is in nanoseconds → ms.
    // (IntervalHistogram has a percentile(p) method, not a .p99 property; p is 0–100.)
    const eventLoopP99Ms = this.histogram.percentile(99) / 1e6

    // Event-loop utilization (0–1) from performance.eventLoopUtilization().
    const { utilization } = performance.eventLoopUtilization()

    // Used heap (bytes) — #9's captureV8Snapshot approach (getHeapStatistics).
    const usedHeapSize = getHeapStatistics().used_heap_size

    // CPU core ratio: (user+system µs) / elapsed µs = cores consumed. Sampled
    // delta-style (cpuUsage since last collect) so the ratio reflects the
    // interval, not the process lifetime.
    const now = process.hrtime.bigint()
    const cpu = process.cpuUsage(this.lastCpu)
    const elapsedUs = Number(now - this.lastTime) / 1000 // ns → µs
    const cpuTotalUs = cpu.user + cpu.system
    const cpuRatio = elapsedUs > 0 ? cpuTotalUs / elapsedUs : 0
    this.lastCpu = process.cpuUsage()
    this.lastTime = now

    return { actorId, eventLoopP99Ms, eventLoopUtilization: utilization, usedHeapSize, cpuRatio }
  }

  /**
   * Collect per-actor readings and aggregate into the `SystemHealth` the
   * admission layer reads. Pure underneath: collect (I/O) → aggregateSystemHealth.
   */
  collectAndAggregate(
    actorIds: readonly string[],
    activeSubagents: number,
    staleSubagents: number,
  ): SystemHealth {
    const readings = actorIds.map((id) => this.collect(id))
    return aggregateSystemHealth(readings, activeSubagents, staleSubagents)
  }

  /** Reset the event-loop histogram (for a fresh measurement window). */
  reset(): void {
    this.histogram.reset()
  }

  /** Disable the histogram — no leaked perf hooks. */
  stop(): void {
    this.histogram.disable()
  }
}
