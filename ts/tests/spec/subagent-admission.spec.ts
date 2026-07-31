/**
 * Unit tests for subagent admission logic and XState machine.
 *
 * Tests every guard in resolveAdmission and every transition in
 * subagentMachine. Pure logic — no I/O, no browser, no fixtures.
 */

import { describe, it, expect } from "vitest"
import { createActor } from "xstate"
import { subagentMachine } from "../src/features/subagent-admission/subagent-admission.machine.js"
import { resolveAdmission } from "../src/features/subagent-admission/subagent-admission.logic.js"
import type { AdmissionPolicy } from "../src/features/subagent-admission/subagent-admission.schema.js"

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

// ── XState machine tests ───────────────────────────────────────

describe("subagentMachine", () => {
  it("starts in created state", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    expect(actor.getSnapshot().value).toBe("created")
  })

  it("transitions created → dispatched on dispatch", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    expect(actor.getSnapshot().value).toBe("dispatched")
  })

  it("transitions dispatched → running on start", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    expect(actor.getSnapshot().value).toBe("running")
  })

  it("transitions running → completed on finish", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "finish" })
    expect(actor.getSnapshot().value).toBe("completed")
  })

  it("transitions running → timed_out on timeout", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "timeout" })
    expect(actor.getSnapshot().value).toBe("timed_out")
  })

  it("transitions running → failed on error", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "error" })
    expect(actor.getSnapshot().value).toBe("failed")
  })

  it("transitions running → yielding on yield", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "yield" })
    expect(actor.getSnapshot().value).toBe("yielding")
  })

  it("transitions yielding → running on child_done", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "yield" })
    actor.send({ type: "child_done" })
    expect(actor.getSnapshot().value).toBe("running")
  })

  it("transitions completed → archived on archive", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "finish" })
    actor.send({ type: "archive" })
    expect(actor.getSnapshot().value).toBe("archived")
  })

  it("transitions aborted from any non-terminal state on parent_abort", () => {
    const states = ["created", "dispatched", "running", "yielding"] as const
    for (const state of states) {
      const actor = createActor(subagentMachine, {
        input: { sessionKey: "test-session" },
      })
      actor.start()
      // Navigate to the target state
      if (state === "dispatched" || state === "running" || state === "yielding") {
        actor.send({ type: "dispatch" })
      }
      if (state === "running" || state === "yielding") {
        actor.send({ type: "start" })
      }
      if (state === "yielding") {
        actor.send({ type: "yield" })
      }
      actor.send({ type: "parent_abort" })
      expect(actor.getSnapshot().value).toBe("aborted")
    }
  })

  it("archived is final — no transitions", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "test-session" },
    })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "finish" })
    actor.send({ type: "archive" })
    // Try sending events — should stay in archived
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "finish" })
    expect(actor.getSnapshot().value).toBe("archived")
  })

  it("terminal states only transition to archived", () => {
    const terminalStates = ["completed", "failed", "timed_out", "aborted"] as const
    for (const state of terminalStates) {
      const actor = createActor(subagentMachine, {
        input: { sessionKey: "test-session" },
      })
      actor.start()
      actor.send({ type: "dispatch" })
      actor.send({ type: "start" })
      if (state === "completed") actor.send({ type: "finish" })
      if (state === "failed") actor.send({ type: "error" })
      if (state === "timed_out") actor.send({ type: "timeout" })
      if (state === "aborted") actor.send({ type: "parent_abort" })

      expect(actor.getSnapshot().value).toBe(state)
      actor.send({ type: "archive" })
      expect(actor.getSnapshot().value).toBe("archived")
    }
  })
})
