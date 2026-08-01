/**
 * BDD integration tests — port of Observatory V2 compliance pattern.
 * Uses TestStore (in-memory, no native deps) instead of better-sqlite3.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { TestStore } from "../../src/test/store.js"
import { resolveChildAdmission } from "../../patches/child-admission.js"
import { transitionSubagent } from "../../src/features/subagent-admission/subagent-admission.machine.js"
import type { AdmissionPolicy } from "../../src/features/subagent-admission/subagent-admission.schema.js"

function insertSubagent(
  store: TestStore,
  key: string,
  opts: { status?: string; spawnedBy?: string; startedAtMs?: number; endedAtMs?: number } = {},
): void {
  store.insert({
    sessionKey: key,
    status: opts.status ?? "running",
    spawnedBy: opts.spawnedBy ?? "agent:main:main",
    isSubagent: 1,
    startedAtMs: opts.startedAtMs ?? Date.now(),
    endedAtMs: opts.endedAtMs ?? null,
  })
}

const testPolicy: AdmissionPolicy = {
  maxSpawnDepth: 1,
  maxChildrenPerAgent: 2,
  maxConcurrent: 2,
  runTimeoutSeconds: 300,
}

describe("Feature: Subagent Spawn Admission — maxConcurrent", () => {
  let store: TestStore

  beforeEach(() => { store = new TestStore() })
  afterEach(() => { store.clear() })

  it("Scenario: Spawn admitted when under concurrent limit", () => {
    expect(store.countActive()).toBe(0)
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: testPolicy.maxSpawnDepth,
      activeChildren: store.countChildren("agent:main:main"),
      maxActiveChildren: testPolicy.maxChildrenPerAgent,
      globalActive: store.countActive(),
      maxConcurrent: testPolicy.maxConcurrent,
      timedOutSubagents: store.getTimedOut(testPolicy.runTimeoutSeconds),
      runTimeoutSeconds: testPolicy.runTimeoutSeconds,
      collect: false,
    })
    expect(result.ok).toBe(true)
  })

  it("Scenario: Spawn rejected when at concurrent limit", () => {
    insertSubagent(store, "agent:main:subagent:1")
    insertSubagent(store, "agent:main:subagent:2")
    expect(store.countActive()).toBe(2)
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: testPolicy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: testPolicy.maxChildrenPerAgent,
      globalActive: store.countActive(), maxConcurrent: testPolicy.maxConcurrent,
      timedOutSubagents: [], runTimeoutSeconds: testPolicy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.maxConcurrent")
      expect(result.error).toContain("global max concurrent")
    }
  })
})

describe("Feature: Subagent Spawn Admission — runTimeout", () => {
  let store: TestStore

  beforeEach(() => { store = new TestStore() })
  afterEach(() => { store.clear() })

  it("Scenario: Spawn rejected when timed-out subagents exist", () => {
    const oldTime = Date.now() - 400000
    insertSubagent(store, "agent:main:subagent:stale", { startedAtMs: oldTime })
    const timedOut = store.getTimedOut(testPolicy.runTimeoutSeconds)
    expect(timedOut).toHaveLength(1)
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: testPolicy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: testPolicy.maxChildrenPerAgent,
      globalActive: 1, maxConcurrent: testPolicy.maxConcurrent,
      timedOutSubagents: timedOut, runTimeoutSeconds: testPolicy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.runTimeoutSeconds")
      expect(result.error).toContain("must be cleaned up")
    }
  })

  it("Scenario: Spawn admitted after cleanup", () => {
    expect(store.getTimedOut(testPolicy.runTimeoutSeconds)).toHaveLength(0)
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: testPolicy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: testPolicy.maxChildrenPerAgent,
      globalActive: 0, maxConcurrent: testPolicy.maxConcurrent,
      timedOutSubagents: [], runTimeoutSeconds: testPolicy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(true)
  })
})

describe("Feature: Subagent Spawn Admission — depth and children", () => {
  let store: TestStore
  const policy: AdmissionPolicy = { ...testPolicy, maxConcurrent: 10 }

  beforeEach(() => { store = new TestStore() })
  afterEach(() => { store.clear() })

  it("Scenario: Spawn rejected at max spawn depth", () => {
    const result = resolveChildAdmission({
      callerDepth: 1, maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0, maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: 0, maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [], runTimeoutSeconds: policy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.governingCap).toBe("subagents.maxSpawnDepth")
  })

  it("Scenario: Spawn rejected at max children per agent", () => {
    insertSubagent(store, "agent:main:subagent:1")
    insertSubagent(store, "agent:main:subagent:2")
    const result = resolveChildAdmission({
      callerDepth: 0, maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: store.countChildren("agent:main:main"),
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: store.countActive(), maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [], runTimeoutSeconds: policy.runTimeoutSeconds, collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.governingCap).toBe("subagents.maxChildrenPerAgent")
  })
})

describe("Feature: Subagent Lifecycle — timeout and archive", () => {
  it("Scenario: Subagent transitions to timed_out", () => {
    let state = transitionSubagent("created", "dispatch")
    state = transitionSubagent(state, "start")
    state = transitionSubagent(state, "timeout")
    expect(state).toBe("timed_out")
  })

  it("Scenario: Timed-out subagent transitions to archived", () => {
    let state = transitionSubagent("created", "dispatch")
    state = transitionSubagent(state, "start")
    state = transitionSubagent(state, "timeout")
    state = transitionSubagent(state, "archive")
    expect(state).toBe("archived")
    state = transitionSubagent(state, "dispatch")
    expect(state).toBe("archived")
  })
})
