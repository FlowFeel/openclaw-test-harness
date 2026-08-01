/**
 * SubagentSupervisor Protocol specs (Phase 2, ticket #15 scaffold).
 *
 * Verifies the MockSupervisor binds the pure `transitionSubagent` table to
 * supervisor lifecycle events, that restart backoff increments retryCount
 * deterministically (via the injected Clock from ticket #7), and that reap is
 * terminal. The Protocol is the only dependency — no I/O, no real threads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { MockSupervisor } from "../../src/features/supervision/mock-supervisor.js"
import { DeterministicTestClock } from "../../src/core/test-context.js"
import type { SupervisorEvent } from "../../src/features/supervision/supervisor.schema.js"

describe("MockSupervisor — Protocol lifecycle binding", () => {
  let supervisor: MockSupervisor
  let clock: DeterministicTestClock

  beforeEach(() => {
    clock = new DeterministicTestClock(1700000000000)
    supervisor = new MockSupervisor({ clock })
  })
  afterEach(() => supervisor.stop())

  it("spawn() creates an actor and immediately dispatches (created → dispatched)", () => {
    const actor = supervisor.spawn({ sessionKey: "a:1" })
    expect(actor.state).toBe("dispatched")
    expect(actor.retryCount).toBe(0)
    expect(actor.pid).toBeNull()
    expect(supervisor.get("a:1")?.state).toBe("dispatched")
  })

  it("signal() drives the pure state machine: dispatched → running → completed", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.signal("a:1", "start")
    expect(supervisor.get("a:1")?.state).toBe("running")
    supervisor.signal("a:1", "finish")
    expect(supervisor.get("a:1")?.state).toBe("completed")
  })

  it("signal() never invents a transition — invalid events are no-ops (delegates to transitionSubagent)", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    // 'finish' is invalid from dispatched (no such transition in TRANSITIONS)
    supervisor.signal("a:1", "finish")
    expect(supervisor.get("a:1")?.state).toBe("dispatched")
  })

  it("emits lifecycle events with deterministic timestamps from the injected clock", () => {
    const events: SupervisorEvent[] = []
    supervisor.onEvent((e) => events.push(e))
    clock.advanceTo(1000)
    supervisor.spawn({ sessionKey: "a:1" })
    clock.advance(500)
    supervisor.signal("a:1", "start")
    clock.advance(500)
    supervisor.signal("a:1", "finish")

    expect(events.map((e) => `${e.type}@${e.atMs}`)).toEqual([
      "spawned@1000",
      "started@1500",
      "completed@2000",
    ])
  })
})

describe("MockSupervisor — restart backoff & reap", () => {
  let supervisor: MockSupervisor
  let clock: DeterministicTestClock

  beforeEach(() => {
    clock = new DeterministicTestClock(0)
    supervisor = new MockSupervisor({
      clock,
      policy: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, backoffFactor: 2 },
    })
  })
  afterEach(() => supervisor.stop())

  it("restart() increments retryCount and returns to dispatched", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "error")
    expect(supervisor.get("a:1")?.state).toBe("failed")

    const restarted = supervisor.restart("a:1")
    expect(restarted).not.toBeNull()
    expect(restarted!.retryCount).toBe(1)
    expect(restarted!.state).toBe("dispatched")
  })

  it("restart() returns null when maxRetries is exceeded (caller must reap)", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "error")
    expect(supervisor.restart("a:1")!.retryCount).toBe(1) // restart 1
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "error")
    expect(supervisor.restart("a:1")!.retryCount).toBe(2) // restart 2 (== maxRetries)
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "error")
    expect(supervisor.restart("a:1")).toBeNull() // exceeded
  })

  it("reap() transitions to archived and drops the actor", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "finish")
    supervisor.reap("a:1")
    expect(supervisor.get("a:1")).toBeNull()
  })

  it("reap() is terminal — a reaped actor is gone, not re-dispatchable", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.reap("a:1")
    expect(() => supervisor.signal("a:1", "start")).toThrow(/Unknown actor/)
  })

  it("stats() tracks spawn/restart/reap counts", () => {
    supervisor.spawn({ sessionKey: "a:1" })
    supervisor.spawn({ sessionKey: "a:2" })
    supervisor.signal("a:1", "start")
    supervisor.signal("a:1", "error")
    supervisor.restart("a:1")
    supervisor.reap("a:2")

    const s = supervisor.stats()
    expect(s.totalSpawned).toBe(2)
    expect(s.totalRestarted).toBe(1)
    expect(s.totalReaped).toBe(1)
    expect(s.active).toBe(1) // a:1 still alive, a:2 reaped
  })
})
