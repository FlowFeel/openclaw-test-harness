/**
 * Deterministic Clock & ID provider specs (Step 1 — DFT).
 *
 * Verifies that Date.now()/Math.random() are replaced by injectable providers
 * yielding fixed timestamps and incrementing counter IDs, and that the
 * providers wire deterministically into existing handlers (TestStore, fanout).
 */
import { describe, it, expect } from "vitest"
import {
  SystemClock,
  DeterministicTestClock,
  SequenceGenerator,
  type Clock,
} from "../../src/core/test-context.js"
import { TestStore } from "../../src/test/store.js"
import { fanoutTopics } from "../../src/features/worker-pool/handlers.js"

describe("SystemClock", () => {
  it("delegates to Date.now() within the call window", () => {
    const clock: Clock = new SystemClock()
    const before = Date.now()
    const t = clock.now()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })
})

describe("DeterministicTestClock", () => {
  it("returns a fixed initial time across repeated calls", () => {
    const clock = new DeterministicTestClock(1700000000000)
    expect(clock.now()).toBe(1700000000000)
    expect(clock.now()).toBe(1700000000000)
  })

  it("advance() moves the fixed time by a delta", () => {
    const clock = new DeterministicTestClock(1000)
    clock.advance(500)
    expect(clock.now()).toBe(1500)
    clock.advance(250)
    expect(clock.now()).toBe(1750)
  })

  it("advanceTo() sets an absolute time", () => {
    const clock = new DeterministicTestClock(1000)
    clock.advanceTo(9999)
    expect(clock.now()).toBe(9999)
  })

  it("is unaffected by wall-clock drift", async () => {
    const clock = new DeterministicTestClock(42)
    await new Promise((r) => setTimeout(r, 10))
    expect(clock.now()).toBe(42)
  })
})

describe("SequenceGenerator", () => {
  it("yields strictly incrementing IDs", () => {
    const gen = new SequenceGenerator()
    expect(gen.nextId()).toBe(1)
    expect(gen.nextId()).toBe(2)
    expect(gen.nextId()).toBe(3)
  })

  it("respects a seed", () => {
    const gen = new SequenceGenerator(100)
    expect(gen.nextId()).toBe(101)
    expect(gen.nextId()).toBe(102)
  })

  it("reset() restores the counter", () => {
    const gen = new SequenceGenerator()
    gen.nextId()
    gen.nextId()
    gen.reset()
    expect(gen.nextId()).toBe(1)
  })

  it("is collision-free across two independent generators", () => {
    const a = new SequenceGenerator()
    const b = new SequenceGenerator(1000)
    expect(a.nextId()).toBe(1)
    expect(b.nextId()).toBe(1001)
    expect(a.nextId()).toBe(2)
    expect(b.nextId()).toBe(1002)
  })
})

describe("Determinism wiring — injectable clock into existing handlers", () => {
  it("TestStore.getTimedOut uses injected nowMs (no Date.now drift)", () => {
    const store = new TestStore()
    const clock = new DeterministicTestClock(1700000000000)
    // started 400s before the fixed clock time → exceeds a 300s timeout
    store.insert({
      sessionKey: "stale",
      status: "running",
      spawnedBy: "p",
      isSubagent: 1,
      startedAtMs: clock.now() - 400_000,
      endedAtMs: null,
    })
    const timedOut = store.getTimedOut(300, clock.now())
    expect(timedOut).toEqual(["stale"])
  })

  it("TestStore.getTimedOut is deterministic across runs at the same clock time", () => {
    const fixed = 1700000000000
    const a = new TestStore()
    a.insert({ sessionKey: "s", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: fixed - 500_000, endedAtMs: null })
    const b = new TestStore()
    b.insert({ sessionKey: "s", status: "running", spawnedBy: "p", isSubagent: 1, startedAtMs: fixed - 500_000, endedAtMs: null })
    expect(a.getTimedOut(300, fixed)).toEqual(b.getTimedOut(300, fixed))
  })

  it("fanoutTopics stamps formattedAt from injected nowMs", () => {
    const fixed = 1700000000000
    const out = fanoutTopics({ topics: ["t1", "t2"], payload: { x: 1 }, nowMs: fixed })
    expect(out).toHaveLength(2)
    expect(out[0].formattedAt).toBe(fixed)
    expect(out[1].formattedAt).toBe(fixed)
    // deterministic: same input → identical output
    const out2 = fanoutTopics({ topics: ["t1", "t2"], payload: { x: 1 }, nowMs: fixed })
    expect(out2).toEqual(out)
  })

  it("fanoutTopics falls back to wall clock when nowMs omitted (backward compatible)", () => {
    const before = Date.now()
    const out = fanoutTopics({ topics: ["t1"], payload: "p" })
    const after = Date.now()
    expect(out[0].formattedAt).toBeGreaterThanOrEqual(before)
    expect(out[0].formattedAt).toBeLessThanOrEqual(after)
  })
})
