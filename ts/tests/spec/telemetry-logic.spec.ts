/**
 * Telemetry pure-logic specs (ticket #17 — the testable seam).
 *
 * Each `it` states a proposition about the pure `aggregateSystemHealth`. No I/O,
 * no perf_hooks, no real processes — the aggregation is fully determined by its
 * inputs. This is the phosphene "determinism as correctness" convention: the
 * aggregation rule (worst-actor-max, total-heap-sum) is a structural property,
 * asserted by exact return values.
 *
 * DFT framing:
 *   - DETERMINISTIC (the load-bearing claims): the exact SystemHealth return
 *     value for each input. No latency, no hermeticity concern — the function
 *     is pure.
 */
import { describe, it, expect } from "vitest"
import { aggregateSystemHealth, type ProcessTelemetry } from "../../src/features/telemetry/telemetry-logic.js"
import type { SystemHealth } from "../../src/features/subagent-admission/subagent-reporting.schema.js"

function reading(
  actorId: string,
  overrides: Partial<ProcessTelemetry> = {},
): ProcessTelemetry {
  return {
    actorId,
    eventLoopP99Ms: 10,
    eventLoopUtilization: 0.2,
    usedHeapSize: 1_000_000,
    cpuRatio: 0.5,
    ...overrides,
  }
}

describe("aggregateSystemHealth — worst-actor-max, total-heap-sum", () => {
  it("returns all-zero SystemHealth for no readings (no actors = no actor pressure)", () => {
    // Edge: no telemetry readings. The actor-derived signals are zero; the
    // counts come from the caller (active/stale may still be > 0 if tracked
    // elsewhere). This is the "no supervised actors yet" case.
    const health = aggregateSystemHealth([], 0, 0)
    expect(health).toEqual<SystemHealth>({
      eventLoopP99Ms: 0,
      eventLoopUtilization: 0,
      cpuCoreRatio: 0,
      activeSubagents: 0,
      staleSubagents: 0,
      registrySizeBytes: 0,
    })
  })

  it("passes through the caller's active/stale counts (telemetry does not invent them)", () => {
    // The counts are the supervisor's authority, not telemetry's. aggregate
    // passes them through verbatim — it never invents activeSubagents.
    const health = aggregateSystemHealth([reading("a:1")], 5, 2)
    expect(health.activeSubagents).toBe(5)
    expect(health.staleSubagents).toBe(2)
  })

  it("aggregates a single reading verbatim (max of one = that one, sum of one = that one)", () => {
    // The trivial aggregation: one actor → its readings are the max and the sum.
    const r = reading("a:1", { eventLoopP99Ms: 42, eventLoopUtilization: 0.6, usedHeapSize: 2_000_000, cpuRatio: 1.2 })
    const health = aggregateSystemHealth([r], 1, 0)
    expect(health.eventLoopP99Ms).toBe(42)
    expect(health.eventLoopUtilization).toBe(0.6)
    expect(health.cpuCoreRatio).toBe(1.2)
    expect(health.registrySizeBytes).toBe(2_000_000)
  })

  it("takes the MAX eventLoopP99 across actors (the worst actor determines pressure)", () => {
    // The admission rule: a single saturated actor should throttle. The worst
    // actor's P99 is the pressure signal — not the average (which would mask it).
    const health = aggregateSystemHealth(
      [reading("a:1", { eventLoopP99Ms: 20 }), reading("a:2", { eventLoopP99Ms: 150 }), reading("a:3", { eventLoopP99Ms: 30 })],
      3, 0,
    )
    expect(health.eventLoopP99Ms).toBe(150)
  })

  it("takes the MAX eventLoopUtilization across actors (worst actor, not average)", () => {
    const health = aggregateSystemHealth(
      [reading("a:1", { eventLoopUtilization: 0.1 }), reading("a:2", { eventLoopUtilization: 0.85 }), reading("a:3", { eventLoopUtilization: 0.3 })],
      3, 0,
    )
    expect(health.eventLoopUtilization).toBe(0.85)
  })

  it("takes the MAX cpuRatio across actors (worst actor, not average)", () => {
    const health = aggregateSystemHealth(
      [reading("a:1", { cpuRatio: 0.5 }), reading("a:2", { cpuRatio: 2.1 }), reading("a:3", { cpuRatio: 0.8 })],
      3, 0,
    )
    expect(health.cpuCoreRatio).toBe(2.1)
  })

  it("SUMS usedHeapSize across actors (total registry footprint, not worst actor)", () => {
    // Heap is additive (each actor's heap is real memory), not max — the total
    // is the registry footprint. This is the one signal where sum (not max) is
    // the right aggregation: 3 actors each using 1MB = 3MB total.
    const health = aggregateSystemHealth(
      [reading("a:1", { usedHeapSize: 1_000_000 }), reading("a:2", { usedHeapSize: 2_500_000 }), reading("a:3", { usedHeapSize: 500_000 })],
      3, 0,
    )
    expect(health.registrySizeBytes).toBe(4_000_000)
  })

  it("combines max + sum correctly across a mixed set of actors", () => {
    // The full aggregation: max for P99/utilization/cpuRatio, sum for heap,
    // passthrough for counts. One deep-equal assertion on the whole SystemHealth.
    const health = aggregateSystemHealth(
      [
        reading("a:1", { eventLoopP99Ms: 15, eventLoopUtilization: 0.2, usedHeapSize: 1_000_000, cpuRatio: 0.4 }),
        reading("a:2", { eventLoopP99Ms: 120, eventLoopUtilization: 0.9, usedHeapSize: 3_000_000, cpuRatio: 1.8 }),
        reading("a:3", { eventLoopP99Ms: 40, eventLoopUtilization: 0.5, usedHeapSize: 500_000, cpuRatio: 0.6 }),
      ],
      3, 1,
    )
    expect(health).toEqual<SystemHealth>({
      eventLoopP99Ms: 120,
      eventLoopUtilization: 0.9,
      cpuCoreRatio: 1.8,
      activeSubagents: 3,
      staleSubagents: 1,
      registrySizeBytes: 4_500_000,
    })
  })
})
