/**
 * Telemetry pure logic — the testable seam of #17 (live telemetry → admission).
 *
 * The aggregation DECISION lives here as a pure function over immutable
 * `ProcessTelemetry` snapshots. The `TelemetryCollector` (the I/O wiring) reads
 * real signals (`perf_hooks.monitorEventLoopDelay`, `performance.eventLoopUtilization`,
 * `v8.getHeapStatistics`, `process.cpuUsage`) and calls this to aggregate them
 * into the `SystemHealth` the admission layer (`evaluateAdaptiveSpawn`) reads.
 *
 * Purity is the seam: the aggregation is testable without perf_hooks, without
 * real processes, without time — the phosphene "pure logic as the seam"
 * convention, same as #14's scheduler and #16's router. The worst actor
 * determines pressure (max eventLoopP99 / utilization / cpuRatio); the total
 * heap is the sum across actors (registrySizeBytes). Admission reacts to the
 * WORST actor, not the average — a single saturated actor should throttle.
 */

import { Schema } from "effect"
import type { SystemHealth } from "../subagent-admission/subagent-reporting.schema.js"

/**
 * Per-actor process telemetry. One reading per supervised actor (or the router
 * process itself). Each field is a real signal collected from the actor's
 * runtime; the actorId makes telemetry per-actor attributable (#17 acceptance #2).
 */
export const ProcessTelemetry = Schema.Struct({
  actorId: Schema.String,
  /** Event-loop P99 latency (ms) from `perf_hooks.monitorEventLoopDelay`. */
  eventLoopP99Ms: Schema.Number,
  /** Event-loop utilization (0–1) from `performance.eventLoopUtilization()`. */
  eventLoopUtilization: Schema.Number,
  /** Used heap size (bytes) from `v8.getHeapStatistics().used_heap_size` (#9). */
  usedHeapSize: Schema.Number,
  /** CPU core ratio (cores) from `process.cpuUsage`, normalized. */
  cpuRatio: Schema.Number,
})
export type ProcessTelemetry = Schema.Schema.Type<typeof ProcessTelemetry>

/**
 * Aggregate per-actor telemetry into the `SystemHealth` the admission layer reads.
 *
 * Pure: (readings, activeSubagents, staleSubagents) → SystemHealth. The worst
 * actor determines pressure (max); the total heap is the sum. Empty readings →
 * zeros (no actors = no actor-derived pressure; counts come from the caller).
 *
 * @param readings - per-actor telemetry snapshots (may be empty).
 * @param activeSubagents - active subagent count (from the supervisor's stats).
 * @param staleSubagents - stale subagent count (from collectStale).
 */
export function aggregateSystemHealth(
  readings: readonly ProcessTelemetry[],
  activeSubagents: number,
  staleSubagents: number,
): SystemHealth {
  // The worst actor determines pressure (max) — a single saturated actor should
  // throttle admission, not be masked by averaging. Heap is additive (sum) — each
  // actor's heap is real memory; the total is the registry footprint. Counts
  // (active/stale) are the supervisor's authority, passed through verbatim.
  if (readings.length === 0) {
    return {
      eventLoopP99Ms: 0,
      eventLoopUtilization: 0,
      cpuCoreRatio: 0,
      activeSubagents,
      staleSubagents,
      registrySizeBytes: 0,
    }
  }

  let maxP99 = 0
  let maxUtil = 0
  let maxCpu = 0
  let totalHeap = 0
  for (const r of readings) {
    if (r.eventLoopP99Ms > maxP99) maxP99 = r.eventLoopP99Ms
    if (r.eventLoopUtilization > maxUtil) maxUtil = r.eventLoopUtilization
    if (r.cpuRatio > maxCpu) maxCpu = r.cpuRatio
    totalHeap += r.usedHeapSize
  }

  return {
    eventLoopP99Ms: maxP99,
    eventLoopUtilization: maxUtil,
    cpuCoreRatio: maxCpu,
    activeSubagents,
    staleSubagents,
    registrySizeBytes: totalHeap,
  }
}
