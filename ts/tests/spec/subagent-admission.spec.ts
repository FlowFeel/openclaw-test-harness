/**
 * Unit tests for subagent admission logic and pure transition state machine.
 *
 * Tests every guard in resolveAdmission and every transition in
 * transitionSubagent. Pure logic — no I/O, no browser, no fixtures.
 */

import { describe, it, expect } from "vitest"
import {
  transitionSubagent,
  TRANSITIONS,
} from "../../src/features/subagent-admission/subagent-admission.machine.js"
import { resolveAdmission, checkAdmission } from "../../src/features/subagent-admission/subagent-admission.logic.js"
import type { AdmissionPolicy } from "../../src/features/subagent-admission/subagent-admission.schema.js"
import { Effect } from "effect"

const testPolicy: AdmissionPolicy = {
  maxSpawnDepth: 1,
  maxChildrenPerAgent: 2,
  maxConcurrent: 2,
  runTimeoutSeconds: 300,
}

// ── Admission logic tests ──────────────────────────────────────

describe("resolveAdmission", () => {
  it("admits spawn when all limits are within bounds", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 0,
      globalActive: 0,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects when caller depth exceeds max", () => {
    const result = resolveAdmission({
      callerDepth: 1,
      activeChildren: 0,
      globalActive: 0,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxSpawnDepth")
    expect(result.reason.toLowerCase()).toContain("depth")
  })

  it("rejects when global concurrent exceeds max", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 0,
      globalActive: 2,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxConcurrent")
    expect(result.reason.toLowerCase()).toContain("concurrent")
  })

  it("rejects when timed-out subagents exist", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 0,
      globalActive: 0,
      timedOutSubagents: ["agent:main:subagent:stale"],
      policy: testPolicy,
    })
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.runTimeoutSeconds")
    expect(result.reason.toLowerCase()).toContain("timeout")
  })

  it("rejects when children per agent exceeds max", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 2,
      globalActive: 0,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxChildrenPerAgent")
  })

  it("checks depth before concurrent", () => {
    const result = resolveAdmission({
      callerDepth: 5,
      activeChildren: 0,
      globalActive: 5,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.cap).toBe("subagents.maxSpawnDepth")
  })

  it("checks concurrent before children", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 5,
      globalActive: 5,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.cap).toBe("subagents.maxConcurrent")
  })

  it("includes all metrics in evidence", () => {
    const result = resolveAdmission({
      callerDepth: 0,
      activeChildren: 1,
      globalActive: 1,
      timedOutSubagents: [],
      policy: testPolicy,
    })
    expect(result.evidence).toHaveProperty("callerDepth")
    expect(result.evidence).toHaveProperty("activeChildren")
    expect(result.evidence).toHaveProperty("globalActive")
    expect(result.evidence).toHaveProperty("maxSpawnDepth")
    expect(result.evidence).toHaveProperty("maxChildrenPerAgent")
    expect(result.evidence).toHaveProperty("maxConcurrent")
  })
})

// ── checkAdmission (Effect-wrapped) tests ──────────────────────

describe("checkAdmission (Effect-wrapped)", () => {
  function makeStore(overrides: {
    activeCount?: number
    childrenCount?: number
    timedOut?: string[]
  } = {}) {
    return {
      getActiveCount: () => Effect.succeed(overrides.activeCount ?? 0),
      getChildrenCount: (_parentKey: string) => Effect.succeed(overrides.childrenCount ?? 0),
      getTimedOutSubagents: (_timeoutSeconds: number) => Effect.succeed(overrides.timedOut ?? []),
    }
  }

  it("admits when all limits are within bounds", async () => {
    const store = makeStore({ activeCount: 0, childrenCount: 0, timedOut: [] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 0, testPolicy, store))
    expect(result.ok).toBe(true)
  })

  it("rejects when global concurrent exceeds max", async () => {
    const store = makeStore({ activeCount: 2, childrenCount: 0, timedOut: [] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 0, testPolicy, store))
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxConcurrent")
  })

  it("rejects when children count exceeds max", async () => {
    const store = makeStore({ activeCount: 0, childrenCount: 2, timedOut: [] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 0, testPolicy, store))
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxChildrenPerAgent")
  })

  it("rejects when timed-out subagents exist", async () => {
    const store = makeStore({ activeCount: 0, childrenCount: 0, timedOut: ["sub:stale"] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 0, testPolicy, store))
    expect(result.ok).toBe(false)
    expect(result.reason.toLowerCase()).toContain("timeout")
  })

  it("rejects when caller depth exceeds max", async () => {
    const store = makeStore({ activeCount: 0, childrenCount: 0, timedOut: [] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 1, testPolicy, store))
    expect(result.ok).toBe(false)
    expect(result.cap).toBe("subagents.maxSpawnDepth")
  })

  it("includes evidence with all metrics", async () => {
    const store = makeStore({ activeCount: 1, childrenCount: 1, timedOut: [] })
    const result = await Effect.runPromise(checkAdmission("parent:1", 0, testPolicy, store))
    expect(result.evidence).toHaveProperty("callerDepth")
    expect(result.evidence).toHaveProperty("activeChildren")
    expect(result.evidence).toHaveProperty("globalActive")
    expect(result.evidence).toHaveProperty("maxSpawnDepth")
  })
})

// ── Pure Transition State Machine tests ────────────────────────

describe("transitionSubagent", () => {
  it("has correct initial and subsequent transitions", () => {
    expect(transitionSubagent("created", "dispatch")).toBe("dispatched")
    expect(transitionSubagent("dispatched", "start")).toBe("running")
    expect(transitionSubagent("running", "finish")).toBe("completed")
    expect(transitionSubagent("completed", "archive")).toBe("archived")
  })

  it("transitions running → timed_out on timeout", () => {
    expect(transitionSubagent("running", "timeout")).toBe("timed_out")
  })

  it("transitions running → failed on error", () => {
    expect(transitionSubagent("running", "error")).toBe("failed")
  })

  it("transitions running → yielding on yield", () => {
    expect(transitionSubagent("running", "yield")).toBe("yielding")
  })

  it("transitions yielding → running on child_done", () => {
    expect(transitionSubagent("yielding", "child_done")).toBe("running")
  })

  it("transitions aborted from any non-terminal state on parent_abort", () => {
    expect(transitionSubagent("created", "parent_abort")).toBe("aborted")
    expect(transitionSubagent("dispatched", "parent_abort")).toBe("aborted")
    expect(transitionSubagent("running", "parent_abort")).toBe("aborted")
    expect(transitionSubagent("yielding", "parent_abort")).toBe("aborted")
  })

  it("archived is final — no transitions", () => {
    expect(transitionSubagent("archived", "dispatch")).toBe("archived")
    expect(transitionSubagent("archived", "start")).toBe("archived")
    expect(transitionSubagent("archived", "finish")).toBe("archived")
  })

  it("terminal states only transition to archived", () => {
    const terminalStates = ["completed", "failed", "timed_out", "aborted"] as const
    for (const state of terminalStates) {
      expect(transitionSubagent(state, "archive")).toBe("archived")
      // Check invalid transitions return current state
      expect(transitionSubagent(state, "dispatch")).toBe(state)
    }
  })

  it("validates transition table structure", () => {
    expect(TRANSITIONS.created.dispatch).toBe("dispatched")
    expect(TRANSITIONS.running.finish).toBe("completed")
    expect(TRANSITIONS.archived).toEqual({})
  })
})
