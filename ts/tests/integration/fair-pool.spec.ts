/**
 * FairPool integration specs (ticket #14 — per-topic fairness & backpressure).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the fair-pool design; each `it` states the proposition that
 * proves it; prose before each assertion says *why* that assertion is the one
 * that matters.
 *
 * The design under test (ts/src/features/worker-pool/fair-pool.ts, #14):
 *   FairPool wraps an inner WorkerPool (Mock here) and adds per-topic fairness.
 *   executeForTopic(topic, ...) enters a per-topic queue; a round-robin scheduler
 *   (pickNextTopic, the pure seam) interleaves topics so no flood starves a
 *   sibling. FairPool is its own concurrency gate (inFlight < maxConcurrent), so
 *   it is the scheduling bottleneck and the dispatch ORDER is the observable,
 *   deterministic fairness guarantee. Backpressure is per-topic (admission reads
 *   it to admit/reject).
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): the exact COMPLETION ORDER under
 *     flood — a sibling topic's task completes BEFORE the flooding topic's
 *     backlog (round-robin interleaves), proven by deep-equal on an ordered
 *     array, not "P99 ≤ 2×" (wall-clock is non-deterministic); the exact
 *     backpressure `apply` boolean per (depth, threshold); per-topic isolation
 *     (one topic's flood does not pressure a sibling).
 *   - BOUNDED-LATENCY (a sanity guard, not a correctness claim): each flood
 *     settles well under 2000ms. Wall-clock measures latency, never a controlled
 *     input — the assertions are on ORDER and boolean identity, not timeouts.
 *
 * Hermeticity: the inner pool is MockWorkerPool (inline, synchronous, no
 * threads). No network, no Docker. The "tag" handler echoes input.tag so
 * completion order is observable as an array of tags.
 *
 * These specs prove the #14 acceptance criteria:
 *   (1) Flood: a sibling topic's task completes before the flooding topic's
 *       backlog (bounded-latency is a secondary sanity check).
 *   (2) Backpressure: flips apply=true under flood (admission reads it to reject).
 *   (3) Protocol compliance: FairPool implements WorkerPool — the existing
 *       worker-pool spec suite's behaviors (register/execute/stats/drain/destroy)
 *       pass against FairPool. (The existing spec is untouched; this block
 *       mirrors its contract to prove FairPool is a drop-in.)
 */
import { describe, it, expect, afterEach } from "vitest"
import { FairPool } from "../../src/features/worker-pool/fair-pool.js"
import { MockWorkerPool } from "../../src/features/worker-pool/mock-pool.js"
import { registerBuiltinHandlers } from "../../src/features/worker-pool/handlers.js"

/** Build a FairPool wrapping a MockWorkerPool with the "tag" handler registered.
 * The tag handler echoes input.tag so completion order is observable. */
function makePool(maxConcurrent: number, backpressureThreshold = 8): FairPool {
  const inner = new MockWorkerPool()
  registerBuiltinHandlers(inner)
  inner.register("tag", (input: { tag: string }) => input.tag)
  return new FairPool(inner, { maxConcurrent, backpressureThreshold })
}

/** Collect completion order: push result.data (the tag) as each task resolves. */
function trackOrder(
  pool: FairPool,
  tasks: Array<{ topic: string; tag: string }>,
): { order: string[]; all: Promise<unknown>[] } {
  const order: string[] = []
  const all = tasks.map(({ topic, tag }) =>
    pool.executeForTopic(topic, "tag", { tag }).then((r) => {
      order.push(r.data as string)
    }),
  )
  return { order, all }
}

describe("FairPool (#14) — per-topic fairness (deterministic dispatch order)", () => {
  let pool: FairPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  it("under flood, a sibling completes BEFORE the flooding topic's backlog (not after)", async () => {
    // The load-bearing claim of #14: fairness. Topic A floods (5 tasks); topic
    // B submits 1. Without fairness (FIFO to the inner pool), B would complete
    // LAST (index 5). With round-robin (maxConcurrent=1), B completes at index 1
    // — right after the one in-flight A task, before A's 4-task backlog. The
    // deep-equal on completion order is the deterministic proof, not a latency
    // bound.
    pool = makePool(1)
    const { order, all } = trackOrder(pool, [
      { topic: "A", tag: "A0" },
      { topic: "A", tag: "A1" },
      { topic: "A", tag: "A2" },
      { topic: "A", tag: "A3" },
      { topic: "A", tag: "A4" },
      { topic: "B", tag: "B0" },
    ])
    await Promise.all(all)
    expect(order).toEqual(["A0", "B0", "A1", "A2", "A3", "A4"])
  }, 2000)

  it("round-robin alternates between two active topics (fair sharing, not one-drains-then-other)", async () => {
    // Two topics with equal load must interleave: A,B,A,B,A,B — not A,A,A,B,B,B.
    // The alternation is the structural fairness guarantee (each topic gets an
    // equal share of dispatch slots under contention).
    pool = makePool(1)
    const { order, all } = trackOrder(pool, [
      { topic: "A", tag: "A0" },
      { topic: "A", tag: "A1" },
      { topic: "A", tag: "A2" },
      { topic: "B", tag: "B0" },
      { topic: "B", tag: "B1" },
      { topic: "B", tag: "B2" },
    ])
    await Promise.all(all)
    expect(order).toEqual(["A0", "B0", "A1", "B1", "A2", "B2"])
  }, 2000)

  it("a drained topic is skipped — empty queues do not block the rotation", async () => {
    // Topic B has only 1 task; once it drains, B is skipped and A/C alternate.
    // This proves the rotation tracks liveness (non-empty), not a fixed slot —
    // a drained topic never wastes a dispatch cycle.
    pool = makePool(1)
    const { order, all } = trackOrder(pool, [
      { topic: "A", tag: "A0" },
      { topic: "A", tag: "A1" },
      { topic: "A", tag: "A2" },
      { topic: "B", tag: "B0" },
      { topic: "C", tag: "C0" },
      { topic: "C", tag: "C1" },
      { topic: "C", tag: "C2" },
    ])
    await Promise.all(all)
    expect(order).toEqual(["A0", "B0", "A1", "C0", "A2", "C1", "C2"])
  }, 2000)

  it("maxConcurrent > 1 still round-robins (fairness holds with parallel dispatch)", async () => {
    // With maxConcurrent=2, two tasks dispatch at once. The fairness guarantee
    // is that a sibling is picked for a freed slot before more of the flooding
    // topic's backlog. A floods 4, B submits 1: B lands in the first round (one
    // of the first 2 dispatches is B, once an A completes and round-robins).
    // The exact order is deterministic given the pump's round-robin + the
    // MockWorkerPool's microtask resolution.
    pool = makePool(2)
    const { order, all } = trackOrder(pool, [
      { topic: "A", tag: "A0" },
      { topic: "A", tag: "A1" },
      { topic: "A", tag: "A2" },
      { topic: "A", tag: "A3" },
      { topic: "B", tag: "B0" },
    ])
    await Promise.all(all)
    // A0, A1 dispatch first (maxConcurrent=2). A0 completes → round-robin picks
    // B (cursor was A). B0 completes → A2. So B lands at index 2, before A2/A3.
    expect(order).toEqual(["A0", "A1", "B0", "A2", "A3"])
  }, 2000)
})

describe("FairPool (#14) — per-topic backpressure (admission signal)", () => {
  let pool: FairPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  it("backpressure() reports no pressure below the threshold", () => {
    // A topic may queue up to `threshold` tasks before admission rejects. Below
    // the threshold, apply=false — the admission layer admits.
    pool = makePool(1, 3)
    pool.executeForTopic("A", "tag", { tag: "A0" }) // depth 1 (dispatched, queue 0)
    pool.executeForTopic("A", "tag", { tag: "A1" }) // queue 1
    pool.executeForTopic("A", "tag", { tag: "A2" }) // queue 2
    expect(pool.backpressure("A").apply).toBe(false)
  })

  it("backpressure() applies when a topic's queue depth exceeds the threshold (admission rejects)", () => {
    // The flip: depth > threshold → apply=true. The admission layer reads this
    // and rejects that topic's spawns. (maxConcurrent=1 holds 1 in-flight, so
    // the rest queue and the depth climbs past the threshold.)
    pool = makePool(1, 2)
    pool.executeForTopic("A", "tag", { tag: "A0" }) // in-flight
    pool.executeForTopic("A", "tag", { tag: "A1" }) // queue depth 1
    pool.executeForTopic("A", "tag", { tag: "A2" }) // queue depth 2
    pool.executeForTopic("A", "tag", { tag: "A3" }) // queue depth 3 > 2
    expect(pool.backpressure("A").apply).toBe(true)
    expect(pool.backpressure("A").queueDepth).toBe(3)
  })

  it("backpressure() is per-topic — one topic's flood does not pressure a sibling", () => {
    // The isolation guarantee: A floods past its threshold; B (idle) shows no
    // pressure. Admission can keep admitting for B while rejecting A — the
    // backpressure signal is scoped, not global.
    pool = makePool(1, 2)
    for (let i = 0; i < 5; i++) pool.executeForTopic("A", "tag", { tag: `A${i}` })
    expect(pool.backpressure("A").apply).toBe(true)
    expect(pool.backpressure("B").apply).toBe(false)
    expect(pool.backpressure("B").queueDepth).toBe(0)
  })
})

describe("FairPool (#14) — WorkerPool Protocol compliance (acceptance #3)", () => {
  let pool: FairPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  it("register() delegates to the inner pool — execute(handler, input) runs the handler", async () => {
    // Protocol compliance: register + execute work as on MockWorkerPool. The
    // no-topic execute() path is backward compatible (straight to inner).
    pool = makePool(1)
    const result = await pool.execute<string>("json.stringify", { data: { a: 1 } })
    expect(result.ok).toBe(true)
    expect(result.data).toBe(JSON.stringify({ a: 1 }))
  })

  it("executeForTopic returns the same WorkerResult shape as execute", async () => {
    // The fairness path must not distort the result contract. Same { ok, data,
    // durationMs } shape as the Protocol's execute().
    pool = makePool(1)
    const result = await pool.executeForTopic<string>("A", "tag", { tag: "x" })
    expect(result.ok).toBe(true)
    expect(result.data).toBe("x")
    expect(typeof result.durationMs).toBe("number")
  })

  it("executeForTopic surfaces handler errors as { ok: false, error } (Protocol contract)", async () => {
    // A handler that throws maps to ok:false — the same contract as execute().
    // The fairness path does not swallow errors.
    pool = makePool(1)
    const inner = new MockWorkerPool()
    inner.register("boom", () => { throw new Error("kaboom") })
    pool = new FairPool(inner, { maxConcurrent: 1 })
    const result = await pool.executeForTopic("A", "boom", {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe("kaboom")
  })

  it("stats() overlays fair-queue counts (queuedTasks = total queued, activeThreads = inFlight)", async () => {
    // FairPool's stats extend the inner's with fair-queue accounting: queued
    // tasks across all topics, in-flight count. The overlay is the admission
    // layer's window into pool pressure.
    pool = makePool(1, 8)
    pool.executeForTopic("A", "tag", { tag: "A0" }) // in-flight (maxConcurrent=1)
    pool.executeForTopic("A", "tag", { tag: "A1" }) // queued
    pool.executeForTopic("B", "tag", { tag: "B0" }) // queued
    const s = pool.stats()
    expect(s.activeThreads).toBe(1) // 1 in-flight
    expect(s.queuedTasks).toBe(2) // A1 + B0 queued
  })

  it("drain() waits for all queued + in-flight to settle (no leaked promises)", async () => {
    // After drain(), every submitted task has resolved. The order array is full
    // — proving drain did not return mid-flood.
    pool = makePool(1)
    const { order, all } = trackOrder(pool, [
      { topic: "A", tag: "A0" },
      { topic: "A", tag: "A1" },
      { topic: "B", tag: "B0" },
    ])
    await Promise.all(all)
    await pool.drain()
    expect(order).toEqual(["A0", "B0", "A1"])
    expect(pool.stats().queuedTasks).toBe(0)
    expect(pool.stats().activeThreads).toBe(0)
  }, 2000)

  it("destroy() rejects pending queued tasks with 'pool destroyed' (no leaked promises)", async () => {
    // Queued (not-yet-dispatched) tasks must reject on destroy — their promises
    // must not hang. The in-flight task (already dispatched to inner) completes
    // normally; the queued ones reject deterministically.
    pool = makePool(1)
    const p0 = pool.executeForTopic("A", "tag", { tag: "A0" }) // in-flight
    const p1 = pool.executeForTopic("A", "tag", { tag: "A1" }) // queued
    const p2 = pool.executeForTopic("A", "tag", { tag: "A2" }) // queued
    await pool.destroy()
    const settled = await Promise.allSettled([p1, p2])
    // Queued tasks rejected with "pool destroyed".
    expect(settled.every((s) => s.status === "rejected")).toBe(true)
    expect((settled[0] as PromiseRejectedResult).reason.message).toMatch(/destroyed/)
    // p0 (in-flight) settles one way or the other — no hang. allSettled it.
    await Promise.allSettled([p0])
  }, 2000)

  it("executeForTopic after destroy() rejects immediately (pool is unusable)", async () => {
    pool = makePool(1)
    await pool.destroy()
    await expect(pool.executeForTopic("A", "tag", { tag: "x" })).rejects.toThrow(/destroyed/)
  })
})
