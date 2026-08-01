/**
 * Tests for adaptive spawn logic and self-reporting state machine.
 *
 * Tests the creative approach:
 * - Adaptive spawning based on health signals (not static caps)
 * - Subagent self-reporting via progress contracts
 * - Stale detection (not killing — yielding)
 * - Effective capacity calculation
 * - Pure state machine with report/stale/yield/checkpoint transitions
 */

import { describe, it, expect } from "vitest"
import {
  transitionAdaptiveState,
  reduceAdaptiveContext,
  ADAPTIVE_TRANSITIONS,
} from "../../src/features/subagent-admission/adaptive-machine.js"
import {
  evaluateAdaptiveSpawn,
  isStale,
  collectStale,
  calculateEffectiveCapacity,
} from "../../src/features/subagent-admission/adaptive-logic.js"
import type {
  AdaptivePolicy,
  SubagentReport,
  SystemHealth,
} from "../../src/features/subagent-admission/subagent-reporting.schema.js"

const testPolicy: AdaptivePolicy = {
  maxAbsolute: 4,
  softLimit: 2,
  eventLoopP99Threshold: 100,
  eventLoopUtilizationThreshold: 0.7,
  cpuCoreRatioThreshold: 1.5,
  defaultReportIntervalMs: 5000,
  defaultStaleAfterMs: 15000,
}

function healthy(): SystemHealth {
  return {
    eventLoopP99Ms: 20,
    eventLoopUtilization: 0.3,
    cpuCoreRatio: 0.5,
    activeSubagents: 0,
    staleSubagents: 0,
  }
}

// ── Adaptive spawn logic ───────────────────────────────────────

describe("evaluateAdaptiveSpawn", () => {
  it("admits when system is healthy and under soft limit", () => {
    const h = healthy()
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(true)
  })

  it("admits when above soft limit but healthy", () => {
    const h = { ...healthy(), activeSubagents: 2 }
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(true)
    expect(result.reason).toContain("Admitted")
  })

  it("rejects at hard max regardless of health", () => {
    const h = { ...healthy(), activeSubagents: 4 }
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(false)
    expect(result.reason).toContain("Hard limit")
  })

  it("rejects when event loop P99 exceeds threshold", () => {
    const h = { ...healthy(), activeSubagents: 2, eventLoopP99Ms: 150 }
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(false)
    expect(result.reason).toContain("P99")
    expect(result.suggestedDelayMs).toBe(150)
  })

  it("rejects when utilization exceeds threshold", () => {
    const h = { ...healthy(), activeSubagents: 2, eventLoopUtilization: 0.85 }
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(false)
    expect(result.reason).toContain("utilization")
  })

  it("rejects when CPU exceeds threshold", () => {
    const h = { ...healthy(), activeSubagents: 2, cpuCoreRatio: 2.0 }
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.admitted).toBe(false)
    expect(result.reason).toContain("CPU")
  })

  it("rejects when stale subagents exist (yield first)", () => {
    const h = { ...healthy(), activeSubagents: 2, staleSubagents: 1 }
    const result = evaluateAdaptiveSpawn(h, testPolicy, ["stale-sub"])
    expect(result.admitted).toBe(false)
    expect(result.reason).toContain("stale")
    expect(result.blockingSubagents).toEqual(["stale-sub"])
  })

  it("includes health snapshot in decision", () => {
    const h = healthy()
    const result = evaluateAdaptiveSpawn(h, testPolicy)
    expect(result.healthSnapshot).toEqual(h)
  })
})

// ── Stale detection ────────────────────────────────────────────

describe("isStale", () => {
  const contract = { staleAfterMs: 15000 }

  it("returns false for recent report", () => {
    const now = Date.now()
    const report: SubagentReport = {
      sessionKey: "test",
      state: "running",
      progress: 0.5,
      lastReportAtMs: now - 5000,
    }
    expect(isStale(report, contract, now)).toBe(false)
  })

  it("returns true for missed report", () => {
    const now = Date.now()
    const report: SubagentReport = {
      sessionKey: "test",
      state: "running",
      progress: 0.5,
      lastReportAtMs: now - 20000,
    }
    expect(isStale(report, contract, now)).toBe(true)
  })

  it("returns false for non-running subagent", () => {
    const now = Date.now()
    const report: SubagentReport = {
      sessionKey: "test",
      state: "done",
      progress: 1.0,
      lastReportAtMs: now - 50000,
    }
    expect(isStale(report, contract, now)).toBe(false)
  })
})

describe("collectStale", () => {
  const contract = { staleAfterMs: 15000 }
  const now = Date.now()

  it("collects only stale running subagents", () => {
    const reports: SubagentReport[] = [
      { sessionKey: "fresh", state: "running", progress: 0.5, lastReportAtMs: now - 1000 },
      { sessionKey: "stale1", state: "running", progress: 0.3, lastReportAtMs: now - 20000 },
      { sessionKey: "stale2", state: "running", progress: 0.7, lastReportAtMs: now - 30000 },
      { sessionKey: "done", state: "done", progress: 1.0, lastReportAtMs: now - 50000 },
    ]
    const stale = collectStale(reports, contract, now)
    expect(stale).toEqual(["stale1", "stale2"])
  })

  it("returns empty when all reports are fresh", () => {
    const reports: SubagentReport[] = [
      { sessionKey: "a", state: "running", progress: 0.5, lastReportAtMs: now - 1000 },
      { sessionKey: "b", state: "running", progress: 0.3, lastReportAtMs: now - 2000 },
    ]
    expect(collectStale(reports, contract, now)).toEqual([])
  })
})

// ── Effective capacity ─────────────────────────────────────────

describe("calculateEffectiveCapacity", () => {
  it("returns full capacity when under soft limit", () => {
    const h = healthy()
    const capacity = calculateEffectiveCapacity(h, testPolicy)
    expect(capacity).toBe(4) // maxAbsolute - 0 active
  })

  it("returns 0 when at hard max", () => {
    const h = { ...healthy(), activeSubagents: 4 }
    expect(calculateEffectiveCapacity(h, testPolicy)).toBe(0)
  })

  it("returns 0 when above soft limit and stressed", () => {
    const h = { ...healthy(), activeSubagents: 2, eventLoopP99Ms: 150 }
    expect(calculateEffectiveCapacity(h, testPolicy)).toBe(0)
  })

  it("returns 1 when above soft limit but healthy", () => {
    const h = { ...healthy(), activeSubagents: 2 }
    expect(calculateEffectiveCapacity(h, testPolicy)).toBe(1)
  })
})

// ── Pure Adaptive Transition State Machine ─────────────────────

describe("adaptiveSubagent transitions", () => {
  it("starts in created and transitions to running", () => {
    expect(transitionAdaptiveState("created", "dispatch")).toBe("dispatched")
    expect(transitionAdaptiveState("dispatched", "start")).toBe("running")
  })

  it("updates progress context on report", () => {
    const context = {
      sessionKey: "test",
      progress: 0,
      lastReportAtMs: 0,
      estimatedRemainingMs: null,
      staleCount: 0,
    }
    const updated = reduceAdaptiveContext(context, {
      type: "report",
      progress: 0.5,
      estimatedRemainingMs: 10000,
    }, 5000)

    expect(updated.progress).toBe(0.5)
    expect(updated.estimatedRemainingMs).toBe(10000)
    expect(updated.lastReportAtMs).toBe(5000)
  })

  it("transitions to stale and increments staleCount", () => {
    expect(transitionAdaptiveState("running", "stale")).toBe("stale")
    
    const context = {
      sessionKey: "test",
      progress: 0.5,
      lastReportAtMs: 1000,
      estimatedRemainingMs: null,
      staleCount: 0,
    }
    const updated = reduceAdaptiveContext(context, { type: "stale" })
    expect(updated.staleCount).toBe(1)
  })

  it("recovers from stale on new report", () => {
    expect(transitionAdaptiveState("stale", "report")).toBe("running")
  })

  it("transitions stale → yielding (not killed)", () => {
    expect(transitionAdaptiveState("stale", "yield")).toBe("yielding")
  })

  it("checkpoints from yielding to completed", () => {
    expect(transitionAdaptiveState("yielding", "checkpoint")).toBe("completed")
  })

  it("resumes from yielding back to running", () => {
    expect(transitionAdaptiveState("yielding", "resume")).toBe("running")
  })

  it("archived is final", () => {
    expect(transitionAdaptiveState("archived", "dispatch")).toBe("archived")
  })

  it("validates adaptive transition table structure", () => {
    expect(ADAPTIVE_TRANSITIONS.created.dispatch).toBe("dispatched")
    expect(ADAPTIVE_TRANSITIONS.running.stale).toBe("stale")
    expect(ADAPTIVE_TRANSITIONS.stale.report).toBe("running")
  })
})
