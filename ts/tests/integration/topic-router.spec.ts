/**
 * TopicRouter integration specs (ticket #16 — per-topic actor isolation).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the per-topic-isolation design; each `it` states the proposition
 * that proves it; prose before each assertion says *why* that assertion is the
 * one that matters.
 *
 * The design under test (ts/src/features/topic-router/topic-router.ts, #16):
 *   TopicRouter extends BaseSupervisor (#15's lifecycle spine) and adds an RPC
 *   layer. Each topic runs as an ISOLATED supervised actor — a dedicated
 *   long-lived worker_thread. dispatch(topic, request) routes to the topic's
 *   actor (lazy-spawn; terminal → restart), awaits the reply. A crash of one
 *   topic's worker is contained: it rejects that topic's in-flight dispatch but
 *   siblings' workers (separate threads) continue serving.
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): crash CONTAINMENT — after topic
 *     A crashes, dispatch to B SUCCEEDS (B's worker is a separate thread, not
 *     affected by A's crash), proven by the exact echoed value, not "B is fast";
 *     A's in-flight dispatch REJECTS with a crash identity ("crashed"/"exited");
 *     per-topic stats attribute state per topic (A failed, B running); restart
 *     produces a NEW actor (different threadId) — self-healing.
 *   - BOUNDED-LATENCY (a sanity guard, not a correctness claim): B's dispatch
 *     after A's crash completes well under 2000ms. Wall-clock measures latency,
 *     never a controlled input — the assertions are on value/rejection identity.
 *
 * Hermeticity: the only "upstream" is the worker_threads runtime. No network,
 * no Docker. The actor entry is ECHO_TOPIC_ENTRY (echoes request; {crash:true}
 * → process.exit(1)). The pure table (transitionSubagent) is the shared contract.
 *
 * These specs prove the #16 acceptance criteria:
 *   (1) Crash one topic actor → sibling topics continue serving (bounded latency).
 *   (2) Per-topic stats attributable (topicStats reports per-topic state).
 *   (3) The router composes #14's backpressure model (per-topic isolation lets
 *       admission see each topic independently — proven by per-topic stats).
 */
import { describe, it, expect, afterEach } from "vitest"
import { TopicRouter, ECHO_TOPIC_ENTRY } from "../../src/features/topic-router/topic-router.js"
import type { RestartPolicy } from "../../src/features/supervision/supervisor.schema.js"

const testPolicy: RestartPolicy = {
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  backoffFactor: 2,
}

describe("TopicRouter (#16) — isolated actors, lazy spawn, RPC", () => {
  let router: TopicRouter

  afterEach(async () => {
    if (router) router.stop()
    await new Promise((r) => setImmediate(r))
  })

  it("dispatch() lazily spawns a topic actor and routes the request (echo reply)", async () => {
    // The thin-router contract: dispatch to a topic with no actor → spawn one,
    // route the request, await the reply. The echo entry returns the request.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    const result = await router.dispatch<string>("A", "hello")
    expect(result).toBe("hello")
    // The actor was spawned and is now running (online → start).
    expect(router.get("A")?.state).toBe("running")
    expect(router.get("A")?.pid).not.toBeNull()
  }, 2000)

  it("dispatch() to a second topic spawns a SEPARATE actor (different threadId)", async () => {
    // Isolation: each topic has its OWN worker thread. Different threadIds prove
    // they're separate actors — a crash of one cannot take down the other.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    const pidA = router.get("A")!.pid
    const pidB = router.get("B")!.pid
    expect(pidA).not.toBeNull()
    expect(pidB).not.toBeNull()
    expect(pidA).not.toBe(pidB)
  }, 2000)

  it("dispatch() routes multiple requests to the same long-lived actor (not one-shot)", async () => {
    // The actor is long-lived (RPC), not one-shot (#15's observe-and-exit). Two
    // dispatches to the same topic hit the SAME actor (same pid) — the actor
    // stays alive across requests.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "first")
    const pidAfterFirst = router.get("A")!.pid
    const second = await router.dispatch("A", "second")
    expect(second).toBe("second")
    expect(router.get("A")!.pid).toBe(pidAfterFirst) // same actor
  }, 2000)
})

describe("TopicRouter (#16) — crash containment (acceptance #1)", () => {
  let router: TopicRouter

  afterEach(async () => {
    if (router) router.stop()
    await new Promise((r) => setImmediate(r))
  })

  it("a crash of topic A rejects A's in-flight dispatch (crash identity, not a hang)", async () => {
    // The crash containment guarantee, load-bearing part 1: A's in-flight
    // dispatch REJECTS (the worker exited). The rejection identity ("crashed"
    // or "exited") proves the exit listener fired — not a 10s hang.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "warmup") // spawn A
    const crashPromise = router.dispatch("A", { crash: true })
    await expect(crashPromise).rejects.toThrow(/crashed|exited/)
    expect(router.get("A")?.state).toBe("failed")
  }, 2000)

  it("after A crashes, B CONTINUES SERVING (sibling isolation — the core #16 guarantee)", async () => {
    // The load-bearing claim of #16: a crash of one topic is CONTAINED. B's
    // worker is a separate thread — A's crash does not take it down. B's
    // dispatch SUCCEEDS with the exact echoed value, proven by deep-equal, not
    // "B is fast." This is the isolation boundary #16 creates.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    // Crash A.
    await expect(router.dispatch("A", { crash: true })).rejects.toThrow(/crashed|exited/)
    expect(router.get("A")?.state).toBe("failed")
    // B is unaffected — its worker is a separate thread.
    const start = Date.now()
    const result = await router.dispatch("B", "still-here")
    const elapsed = Date.now() - start
    expect(result).toBe("still-here")
    expect(elapsed).toBeLessThan(2000) // bounded-latency sanity guard
    expect(router.get("B")?.state).toBe("running")
  }, 3000)

  it("crashContainment() reports A crashed and B still serving (pure decision, live snapshot)", async () => {
    // The pure containment decision applied to live state: after A crashes,
    // crashContainment("A") returns { crashed: "A", serving: ["B"] }. This makes
    // the isolation guarantee explicit and queryable for the admission layer.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    await expect(router.dispatch("A", { crash: true })).rejects.toThrow(/crashed|exited/)
    const result = router.crashContainment("A")
    expect(result.crashed).toBe("A")
    expect(result.serving).toEqual(["B"])
  }, 3000)

  it("dispatch() to a crashed topic self-heals (restart → fresh actor → succeeds)", async () => {
    // Self-healing: after A crashes (failed), a subsequent dispatch restarts A
    // (fresh actor, new threadId) and succeeds. The router is self-healing — a
    // crash doesn't permanently kill the topic.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "first")
    const pidBefore = router.get("A")!.pid
    await expect(router.dispatch("A", { crash: true })).rejects.toThrow(/crashed|exited/)
    // Self-heal: dispatch again → restart → fresh actor.
    const result = await router.dispatch("A", "recovered")
    expect(result).toBe("recovered")
    expect(router.get("A")?.state).toBe("running")
    expect(router.get("A")?.retryCount).toBe(1)
    expect(router.get("A")?.pid).not.toBe(pidBefore) // fresh actor
  }, 3000)
})

describe("TopicRouter (#16) — per-topic attribution (acceptance #2)", () => {
  let router: TopicRouter

  afterEach(async () => {
    if (router) router.stop()
    await new Promise((r) => setImmediate(r))
  })

  it("topicStats() attributes state per topic (A running, B running)", async () => {
    // Per-topic attribution: the supervisor reports per-actor stats. topicStats
    // returns one stat per topic with state/retryCount/active. The admission
    // layer reads these per-topic (acceptance #2 / #3 — each topic seen independently).
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    const stats = router.topicStats()
    expect(stats).toEqual([
      { topic: "A", state: "running", retryCount: 0, active: true },
      { topic: "B", state: "running", retryCount: 0, active: true },
    ])
  }, 2000)

  it("topicStats() reflects a crash per-topic (A failed/inactive, B running/active)", async () => {
    // After A crashes, topicStats shows A inactive (failed) and B active
    // (running) — the crash is attributed to A only, not B. This is the
    // per-topic visibility the admission layer needs to throttle A independently.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    await expect(router.dispatch("A", { crash: true })).rejects.toThrow(/crashed|exited/)
    const stats = router.topicStats()
    const aStat = stats.find((s) => s.topic === "A")!
    const bStat = stats.find((s) => s.topic === "B")!
    expect(aStat.active).toBe(false)
    expect(aStat.state).toBe("failed")
    expect(bStat.active).toBe(true)
    expect(bStat.state).toBe("running")
  }, 3000)
})

describe("TopicRouter (#16) — lifecycle & Protocol compliance (builds on #15)", () => {
  let router: TopicRouter

  afterEach(async () => {
    if (router) router.stop()
    await new Promise((r) => setImmediate(r))
  })

  it("restart() produces a fresh actor (different threadId, retryCount+1)", async () => {
    // The #15 restart contract, honored by #16: restart creates a NEW worker
    // (different threadId), increments retryCount. The old run is discarded.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    const pidBefore = router.get("A")!.pid
    const restarted = router.restart("A")!
    expect(restarted.retryCount).toBe(1)
    expect(restarted.pid).not.toBe(pidBefore)
  }, 2000)

  it("reap() terminates the topic's actor and drops it", async () => {
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    router.reap("A")
    expect(router.get("A")).toBeNull()
    expect(router.stats().totalReaped).toBe(1)
  }, 2000)

  it("never invents a transition — invalid signal is a no-op (delegates to transitionSubagent)", async () => {
    // The #15 invariant, preserved: the router binds real events to the table
    // but never invents a transition. 'archive' from running is invalid → no-op.
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    router.signal("A", "archive")
    expect(router.get("A")?.state).toBe("running")
  }, 2000)

  it("stop() reaps all topic actors (clean shutdown, no leaked workers)", async () => {
    router = new TopicRouter({ actorEntry: ECHO_TOPIC_ENTRY, policy: testPolicy })
    await router.dispatch("A", "a")
    await router.dispatch("B", "b")
    router.stop()
    expect(router.get("A")).toBeNull()
    expect(router.get("B")).toBeNull()
    expect(router.topicStats()).toEqual([])
  }, 2000)
})
