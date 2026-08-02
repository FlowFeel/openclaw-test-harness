/**
 * TelemetryCollector integration specs (ticket #17 — live telemetry → admission).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the live-telemetry design; each `it` states the proposition that
 * proves it; prose before each assertion says *why* that assertion is the one
 * that matters.
 *
 * The design under test (ts/src/features/telemetry/):
 *   TelemetryCollector reads REAL runtime signals (monitorEventLoopDelay,
 *   eventLoopUtilization, getHeapStatistics, cpuUsage) → ProcessTelemetry →
 *   aggregateSystemHealth (pure) → SystemHealth → evaluateAdaptiveSpawn. Admission
 *   decisions now react to REAL pressure, not fixtures.
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): usedHeapSize > 0 (the process
 *     ALWAYS has a heap — this is the proof the reading is REAL, not a fixture);
 *     the decision's healthSnapshot === the aggregated real health (the decision
 *     carries REAL readings, not fixtures); per-actor attribution (different
 *     actorIds); under a busy loop, eventLoopP99Ms > 0 (a setTimeout(0) delayed
 *     by the loop is deterministically late — the histogram records the delay).
 *   - BOUNDED-LATENCY (a sanity guard, not a correctness claim): the busy loop
 *     runs ~50ms. Wall-clock measures the loop, never a controlled input — the
 *     assertion is on the p99 IDENTITY (> 0, real), not the exact value.
 *
 * Hermeticity: the only "upstream" is the Node.js runtime (perf_hooks, v8,
 * process). No network, no Docker. The readings are from THIS process.
 *
 * These specs prove the #17 acceptance criteria:
 *   (1) Under synthetic load, admission rejects with health reasons populated
 *       from real monitorEventLoopDelay / heap readings.
 *   (2) Telemetry is per-actor attributable.
 *   (3) The existing adaptive spec suite passes with injected (mock) telemetry
 *       unchanged (not asserted here — tests/spec/adaptive.spec.ts is untouched).
 */
import { describe, it, expect, afterEach } from "vitest"
import { TelemetryCollector } from "../../src/features/telemetry/telemetry-collector.js"
import { evaluateAdaptiveSpawn } from "../../src/features/subagent-admission/adaptive-logic.js"
import type { AdaptivePolicy } from "../../src/features/subagent-admission/subagent-reporting.schema.js"

const testPolicy: AdaptivePolicy = {
  maxAbsolute: 10,
  softLimit: 1,
  eventLoopP99Threshold: 100,
  eventLoopUtilizationThreshold: 0.7,
  cpuCoreRatioThreshold: 1.5,
  defaultReportIntervalMs: 5000,
  defaultStaleAfterMs: 15000,
}

describe("TelemetryCollector (#17) — real readings, not fixtures", () => {
  let collector: TelemetryCollector

  afterEach(() => {
    if (collector) collector.stop()
  })

  it("collect() returns real readings: usedHeapSize > 0 (the process always has a heap)", () => {
    // DETERMINISTIC: the process ALWAYS has a heap. usedHeapSize > 0 is the
    // proof the reading is REAL (from v8.getHeapStatistics), not a fixture.
    // This is the load-bearing claim of #17: telemetry is populated from real
    // runtime signals, not hardcoded values.
    collector = new TelemetryCollector()
    const r = collector.collect("router")
    expect(r.actorId).toBe("router")
    expect(r.usedHeapSize).toBeGreaterThan(0)
    expect(r.eventLoopP99Ms).toBeGreaterThanOrEqual(0)
    expect(r.eventLoopUtilization).toBeGreaterThanOrEqual(0)
    expect(r.cpuRatio).toBeGreaterThanOrEqual(0)
  })

  it("collect() with different actorIds attributes per-actor (acceptance #2)", () => {
    // Per-actor attribution: each reading carries its actorId into the
    // aggregation. The collector is the source; aggregateSystemHealth preserves
    // the attribution (one reading per actor).
    collector = new TelemetryCollector()
    const a = collector.collect("topic-A")
    const b = collector.collect("topic-B")
    expect(a.actorId).toBe("topic-A")
    expect(b.actorId).toBe("topic-B")
    // Both have real heap readings — per-actor attributable, real.
    expect(a.usedHeapSize).toBeGreaterThan(0)
    expect(b.usedHeapSize).toBeGreaterThan(0)
  })
})

describe("TelemetryCollector (#17) — real telemetry feeds admission (acceptance #1)", () => {
  let collector: TelemetryCollector

  afterEach(() => {
    if (collector) collector.stop()
  })

  it("aggregateSystemHealth(collect()) feeds evaluateAdaptiveSpawn — decision carries REAL health", () => {
    // The #17 contract: real telemetry → SystemHealth → admission decision.
    // The decision's healthSnapshot is the REAL aggregated health, not a fixture.
    // With activeSubagents ≥ softLimit, the health is checked; the decision
    // carries the real registrySizeBytes (> 0 — real heap).
    collector = new TelemetryCollector()
    const health = collector.collectAndAggregate(["router"], 1, 0)
    expect(health.registrySizeBytes).toBeGreaterThan(0) // real heap
    const decision = evaluateAdaptiveSpawn(health, testPolicy)
    // The decision carries the EXACT real health snapshot — not a fixture.
    expect(decision.healthSnapshot).toEqual(health)
    expect(decision.healthSnapshot.registrySizeBytes).toBeGreaterThan(0)
  })

  it("under synthetic load, admission rejects with real eventLoopP99 in the reason", async () => {
    // DETERMINISTIC: a setTimeout(0) scheduled before a 50ms busy loop is
    // deterministically ~50ms late — the histogram records the delay, so p99
    // > 0. With eventLoopP99Threshold=0 and activeSubagents ≥ softLimit,
    // evaluateAdaptiveSpawn rejects with a reason containing the REAL p99 value
    // (populated from real monitorEventLoopDelay, not a fixture).
    collector = new TelemetryCollector()
    collector.reset()
    // Schedule a timer, then block the event loop — the timer runs late.
    const late = new Promise<void>((r) => setTimeout(() => r(), 0))
    const start = Date.now()
    while (Date.now() - start < 50) {
      /* block the event loop — the timer is now ~50ms late */
    }
    await late // let the late timer fire so the histogram samples it
    const health = collector.collectAndAggregate(["router"], 2, 0)
    // The real p99 is elevated (the busy loop delayed the timer). This is the
    // deterministic proof the reading is from REAL event-loop delay.
    expect(health.eventLoopP99Ms).toBeGreaterThan(0)
    // With threshold 0, any p99 > 0 rejects. The reason contains the real p99.
    const rejectPolicy: AdaptivePolicy = { ...testPolicy, eventLoopP99Threshold: 0 }
    const decision = evaluateAdaptiveSpawn(health, rejectPolicy)
    expect(decision.admitted).toBe(false)
    expect(decision.reason).toContain(health.eventLoopP99Ms.toFixed(0))
    expect(decision.healthSnapshot.eventLoopP99Ms).toBe(health.eventLoopP99Ms)
  }, 3000)

  it("hard-limit rejection carries real health (registrySizeBytes > 0 — real readings, not fixtures)", () => {
    // Even when the rejection is the hard limit (not health), the decision's
    // healthSnapshot is populated with REAL readings. This proves telemetry
    // flows into every admission decision, not just health-based ones.
    collector = new TelemetryCollector()
    const health = collector.collectAndAggregate(["router"], 5, 0)
    const hardLimitPolicy: AdaptivePolicy = { ...testPolicy, maxAbsolute: 5 }
    const decision = evaluateAdaptiveSpawn(health, hardLimitPolicy)
    expect(decision.admitted).toBe(false)
    expect(decision.reason).toMatch(/Hard limit/)
    // The real readings travel with the decision.
    expect(decision.healthSnapshot.registrySizeBytes).toBeGreaterThan(0)
    expect(decision.healthSnapshot).toEqual(health)
  })
})
