/**
 * Docker integration test — runs inside a container.
 * No native dependencies — uses pure JS TestStore.
 */

import { describe, it, expect } from "vitest"
import { TestStore } from "../../src/test/store.js"
import { resolveChildAdmission } from "../../patches/child-admission.js"
import { subagentMachine } from "../../src/features/subagent-admission/subagent-admission.machine.js"
import { createActor } from "xstate"
import type { AdmissionPolicy } from "../../src/features/subagent-admission/subagent-admission.schema.js"

describe("Docker container environment", () => {
  it("runs inside a container with Node.js", () => {
    expect(process.version).toMatch(/^v2[0-9]+\./)
  })

  it("has TestStore available", () => {
    const store = new TestStore()
    store.insert({ sessionKey: "test", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: Date.now(), endedAtMs: null })
    expect(store.countActive()).toBe(1)
  })

  it("has network stack available", () => {
    expect(typeof fetch).toBe("function")
  })
})

describe("Docker BDD: Full spawn → timeout → archive cycle", () => {
  const policy: AdmissionPolicy = { maxSpawnDepth: 1, maxChildrenPerAgent: 2, maxConcurrent: 2, runTimeoutSeconds: 1 }

  it("admits spawn in empty system", () => {
    const store = new TestStore()
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: store.countActive(), maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: store.getTimedOut(policy.runTimeoutSeconds),
      runTimeoutSeconds: policy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects spawn at concurrent limit", () => {
    const store = new TestStore()
    const now = Date.now()
    store.insert({ sessionKey: "s1", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: now, endedAtMs: null })
    store.insert({ sessionKey: "s2", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: now, endedAtMs: null })
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: store.countActive(), maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [], runTimeoutSeconds: policy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.governingCap).toBe("subagents.maxConcurrent")
  })

  it("rejects spawn when timed-out subagent exists", () => {
    const store = new TestStore()
    const oldTime = Date.now() - 5000
    store.insert({ sessionKey: "stale", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: oldTime, endedAtMs: null })
    const timedOut = store.getTimedOut(policy.runTimeoutSeconds)
    expect(timedOut).toHaveLength(1)
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: 1, maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: timedOut, runTimeoutSeconds: policy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.governingCap).toBe("subagents.runTimeoutSeconds")
  })

  it("full lifecycle: spawn → running → timeout → archive", () => {
    const actor = createActor(subagentMachine, { input: { sessionKey: "docker-test" } })
    actor.start()
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    expect(actor.getSnapshot().value).toBe("running")
    actor.send({ type: "timeout" })
    expect(actor.getSnapshot().value).toBe("timed_out")
    actor.send({ type: "archive" })
    expect(actor.getSnapshot().value).toBe("archived")
    actor.send({ type: "dispatch" })
    expect(actor.getSnapshot().value).toBe("archived")
  })
})
