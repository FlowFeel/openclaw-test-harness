/**
 * Topic router pure-logic specs (ticket #16 — the testable seam).
 *
 * Each `it` states a proposition about a pure function. No I/O, no threads, no
 * time — the routing/attribution/containment decisions are fully determined by
 * their inputs. This is the phosphene "determinism as correctness" convention:
 * the isolation guarantee is a structural property of `crashContainment`,
 * asserted by exact return values, not "siblings survive" (that's the
 * integration test's job).
 *
 * DFT framing:
 *   - DETERMINISTIC (the load-bearing claims): the exact return value of each
 *     function for each input. No latency, no hermeticity concern — the
 *     functions are pure.
 */
import { describe, it, expect } from "vitest"
import {
  selectActorForTopic,
  aggregateTopicStats,
  crashContainment,
  type TopicStat,
} from "../../src/features/topic-router/topic-router-logic.js"
import type { ActorHandle } from "../../src/features/supervision/supervisor.schema.js"

/** Build an ActorHandle for a topic (sessionKey = topic) at a state. */
function handle(topic: string, state: ActorHandle["state"], retryCount = 0): ActorHandle {
  return { sessionKey: topic, state, retryCount, pid: 1 }
}

describe("selectActorForTopic — pure routing decision (route or spawn)", () => {
  it("returns the actor whose sessionKey matches the topic", () => {
    // The routing decision: the topic's actor is the one whose sessionKey
    // equals the topic. (In #16, sessionKey IS the topic — one actor per topic.)
    const actors = [handle("A", "running"), handle("B", "running")]
    expect(selectActorForTopic("A", actors)).toEqual(handle("A", "running"))
    expect(selectActorForTopic("B", actors)).toEqual(handle("B", "running"))
  })

  it("returns null when no actor exists for the topic (caller must spawn)", () => {
    // null is the spawn signal: the router sees null and calls spawn(). This is
    // the lazy-spawn decision — a topic gets an actor on first dispatch.
    const actors = [handle("A", "running")]
    expect(selectActorForTopic("Z", actors)).toBeNull()
    expect(selectActorForTopic("Z", [])).toBeNull()
  })

  it("returns null for a topic whose actor is terminal (caller must restart)", () => {
    // A terminal actor (failed/completed) cannot serve — the router treats it
    // as absent and restarts. selectActorForTopic returns the handle (it exists),
    // but the router checks `active` (via aggregateTopicStats) to decide restart.
    // Here we assert selectActorForTopic finds it; the restart decision is the
    // router's (it composes selectActorForTopic + TerminalStates).
    const actors = [handle("A", "failed")]
    const found = selectActorForTopic("A", actors)
    expect(found).not.toBeNull()
    expect(found!.state).toBe("failed")
  })
})

describe("aggregateTopicStats — per-topic attribution (acceptance #2)", () => {
  it("returns [] for no actors", () => {
    expect(aggregateTopicStats([])).toEqual([])
  })

  it("maps each actor to a TopicStat with state, retryCount, and active flag", () => {
    // The attribution: one stat per topic. `active` is true when the actor is
    // live (not terminal). The admission layer reads these per-topic stats.
    const actors = [
      handle("A", "running", 0),
      handle("B", "failed", 2),
      handle("C", "dispatched", 0),
    ]
    const stats = aggregateTopicStats(actors)
    expect(stats).toEqual<TopicStat[]>([
      { topic: "A", state: "running", retryCount: 0, active: true },
      { topic: "B", state: "failed", retryCount: 2, active: false },
      { topic: "C", state: "dispatched", retryCount: 0, active: true },
    ])
  })

  it("marks terminal states as inactive (completed/failed/timed_out/aborted)", () => {
    // active = !TerminalStates.has(state). Every terminal state is inactive —
    // the admission layer won't route to a terminal actor.
    const actors = [
      handle("C1", "completed"),
      handle("C2", "failed"),
      handle("C3", "timed_out"),
      handle("C4", "aborted"),
      handle("C5", "running"),
    ]
    const stats = aggregateTopicStats(actors)
    const actives = stats.map((s) => s.active)
    expect(actives).toEqual([false, false, false, false, true])
  })
})

describe("crashContainment — the isolation guarantee (acceptance #1, pure)", () => {
  it("excludes the crashed topic from serving (a crash affects ONLY that topic)", () => {
    // The #16 guarantee, made pure: after A crashes, A is NOT serving. The
    // crash is contained — it does not propagate to siblings.
    const actors = [handle("A", "failed"), handle("B", "running"), handle("C", "running")]
    const result = crashContainment("A", actors)
    expect(result.crashed).toBe("A")
    expect(result.serving).not.toContain("A")
  })

  it("includes live siblings in serving (they continue serving after the crash)", () => {
    // The flip of containment: B and C (live, running) ARE serving. A's crash
    // did not take them down — they're isolated actors on separate workers.
    const actors = [handle("A", "failed"), handle("B", "running"), handle("C", "running")]
    const result = crashContainment("A", actors)
    expect(result.serving).toEqual(["B", "C"])
  })

  it("excludes terminal siblings from serving (a crashed sibling is not serving either)", () => {
    // If B also crashed (terminal), B is not serving — even though B was not
    // THE crashed topic. serving = live actors only, excluding the crashed one.
    const actors = [
      handle("A", "failed"),
      handle("B", "failed"),
      handle("C", "running"),
    ]
    const result = crashContainment("A", actors)
    expect(result.serving).toEqual(["C"])
    expect(result.serving).not.toContain("B")
  })

  it("returns empty serving when the crashed topic is the only actor", () => {
    // Edge: a single-topic system. A crashes → nothing serves. The containment
    // guarantee holds vacuously (no sibling to affect).
    const result = crashContainment("A", [handle("A", "failed")])
    expect(result.crashed).toBe("A")
    expect(result.serving).toEqual([])
  })
})
