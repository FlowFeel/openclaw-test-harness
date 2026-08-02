/**
 * Fair scheduler pure-logic specs (ticket #14 — the testable seam).
 *
 * Each `it` states a proposition about a pure function. No I/O, no threads, no
 * time — the scheduling decision is fully determined by its inputs. This is the
 * phosphene "determinism as correctness" convention: the fairness guarantee is
 * a structural property of `pickNextTopic`, asserted by exact return values, not
 * "it's fair" or "latency is low."
 *
 * DFT framing:
 *   - DETERMINISTIC (the load-bearing claims): the exact return value of
 *     pickNextTopic for each (nonEmpty, cursor) pair; the exact `apply` boolean
 *     for each (depth, threshold) pair. There is no latency or hermeticity
 *     concern here — the functions are pure.
 */
import { describe, it, expect } from "vitest"
import { pickNextTopic, evaluateBackpressure } from "../../src/features/worker-pool/fair-scheduler.js"

describe("pickNextTopic — round-robin selection over non-empty queues", () => {
  it("returns null when no topic has queued work", () => {
    // The pump stops when there is nothing to dispatch. null is the sentinel.
    expect(pickNextTopic([], null)).toBeNull()
  })

  it("returns the first topic when the cursor is null (initial dispatch)", () => {
    // The very first dispatch has no prior cursor — serve the head of the order.
    expect(pickNextTopic(["A", "B", "C"], null)).toBe("A")
  })

  it("returns the topic after the cursor (round-robin advances, no re-serving)", () => {
    // The whole point: after serving A, serve B (not A again). This is what
    // prevents one topic from monopolizing the pool under flood.
    expect(pickNextTopic(["A", "B", "C"], "A")).toBe("B")
    expect(pickNextTopic(["A", "B", "C"], "B")).toBe("C")
  })

  it("wraps around to the first topic after the last (cyclic rotation)", () => {
    // Round-robin is cyclic: after the tail, back to the head. A topic at the
    // end of the order is not starved — it gets served, then rotation wraps.
    expect(pickNextTopic(["A", "B", "C"], "C")).toBe("A")
  })

  it("returns the first topic when the cursor is no longer non-empty (its queue drained)", () => {
    // When the last-served topic's queue empties, it drops out of nonEmpty. The
    // cursor no longer names a live topic, so rotation restarts at the head —
    // not at some stale "next" that might also have drained.
    expect(pickNextTopic(["A", "C"], "B")).toBe("A")
  })

  it("returns the sole non-empty topic repeatedly when only one queue has work (no starvation via wrap)", () => {
    // If only one topic has work, round-robin wraps to itself — that topic gets
    // every dispatch slot. This is correct: there is no sibling to share with.
    // (Fairness is about SHARING when there is contention, not idling when there
    // isn't.)
    expect(pickNextTopic(["A"], null)).toBe("A")
    expect(pickNextTopic(["A"], "A")).toBe("A")
  })

  it("preserves insertion order, not alphabetical (the caller's enqueue order is authoritative)", () => {
    // The order is the order topics were first enqueued, not sorted. This keeps
    // the rotation stable and predictable for the caller.
    expect(pickNextTopic(["C", "A", "B"], null)).toBe("C")
    expect(pickNextTopic(["C", "A", "B"], "C")).toBe("A")
    expect(pickNextTopic(["C", "A", "B"], "A")).toBe("B")
    expect(pickNextTopic(["C", "A", "B"], "B")).toBe("C")
  })
})

describe("evaluateBackpressure — per-topic admission signal", () => {
  it("does not apply backpressure when depth is at or below the threshold", () => {
    // A topic may queue up to `threshold` tasks before the admission layer
    // rejects. At the threshold (depth === threshold), still no pressure — the
    // topic is within its allowance.
    const at = evaluateBackpressure(8, 8)
    expect(at.apply).toBe(false)
    expect(at.queueDepth).toBe(8)
    expect(at.threshold).toBe(8)

    const below = evaluateBackpressure(3, 8)
    expect(below.apply).toBe(false)
  })

  it("applies backpressure when depth EXCEEDS the threshold (strict >, not ≥)", () => {
    // The flip point: depth > threshold. The admission layer reads `apply` and
    // rejects that topic's spawns. Strict > means the threshold is the last
    // allowed depth, not the first rejected one.
    const over = evaluateBackpressure(9, 8)
    expect(over.apply).toBe(true)
    expect(over.queueDepth).toBe(9)
    expect(over.threshold).toBe(8)
  })

  it("carries the depth and threshold as admission evidence", () => {
    // The admission layer's rejection must include evidence (the #4 convention:
    // every rejection carries its metrics). The result is that evidence — depth
    // and threshold travel with the decision so the caller never re-queries.
    const r = evaluateBackpressure(12, 5)
    expect(r).toEqual({ apply: true, queueDepth: 12, threshold: 5 })
  })

  it("threshold 0 applies backpressure on any queued task (panic threshold)", () => {
    // A threshold of 0 means "reject as soon as anything is queued" — the panic
    // setting. depth 1 > 0 → apply. (depth 0 > 0 is false → no pressure, but an
    // empty queue never queries backpressure in practice.)
    expect(evaluateBackpressure(1, 0).apply).toBe(true)
    expect(evaluateBackpressure(0, 0).apply).toBe(false)
  })
})
