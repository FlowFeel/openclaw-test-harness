/**
 * Fair scheduler — pure logic for per-topic fairness & backpressure (ticket #14).
 *
 * The testable seam of #14. Two pure functions:
 *   - pickNextTopic: round-robin selection over non-empty topic queues. Given
 *     the set of non-empty topics and the last-served cursor, returns the next
 *     topic to dispatch. Deterministic, no I/O, no mutation.
 *   - evaluateBackpressure: given a topic's queue depth and a threshold, returns
 *     a BackpressureResult the admission layer reads to admit or reject.
 *
 * Purity is the seam: FairPool (the I/O wiring) calls these on immutable
 * snapshots (the non-empty topic list, the cursor, the depth). The scheduling
 * decision is testable without the pool, without threads, without time — exactly
 * the phosphene "pure logic as the seam" convention.
 *
 * Round-robin, not deficit round-robin: uniform-cost fairness (each topic gets
 * an equal share of dispatch slots). DRR (weighted by task cost) is the
 * documented extension point — the pure signature leaves room for it without a
 * redesign, but YAGNI until per-task cost weighting is needed.
 */

/** A backpressure decision for one topic. The admission layer reads `apply`. */
export interface BackpressureResult {
  /** True when the topic's queue depth exceeds the threshold — admission rejects. */
  readonly apply: boolean
  /** The queue depth the decision was made from (admission evidence). */
  readonly queueDepth: number
  /** The threshold the decision was made against (admission evidence). */
  readonly threshold: number
}

/**
 * Pick the next topic to dispatch, round-robin.
 *
 * @param nonEmptyTopics - topics with queued tasks, in insertion order. Depth 0
 *   topics are excluded by the caller; this function only does the rotation.
 * @param cursor - the last-served topic, or null for the initial dispatch.
 * @returns the next topic, or null when no topic has queued work.
 */
export function pickNextTopic(
  nonEmptyTopics: readonly string[],
  cursor: string | null,
): string | null {
  if (nonEmptyTopics.length === 0) return null
  if (cursor === null) return nonEmptyTopics[0]
  const idx = nonEmptyTopics.indexOf(cursor)
  // Cursor's queue drained (it's no longer non-empty): restart at the head.
  // Restarting — not advancing a stale index — keeps the rotation stable when
  // multiple topics drain in one pump cycle.
  if (idx === -1) return nonEmptyTopics[0]
  // Advance past the cursor, wrapping cyclically. With a sole non-empty topic,
  // this wraps to itself — that topic gets every slot (correct: no sibling to
  // share with). This is the round-robin fairness guarantee.
  return nonEmptyTopics[(idx + 1) % nonEmptyTopics.length]
}

/**
 * Evaluate backpressure for one topic. Pure: (depth, threshold) → decision.
 *
 * Backpressure applies when depth EXCEEDS the threshold (strict >), so a topic
 * may queue up to `threshold` tasks before the admission layer starts rejecting.
 */
export function evaluateBackpressure(
  queueDepth: number,
  threshold: number,
): BackpressureResult {
  // Strict > : the threshold is the last ALLOWED depth, not the first rejected.
  // A topic may queue up to `threshold` tasks; the (threshold+1)th flips apply.
  return { apply: queueDepth > threshold, queueDepth, threshold }
}
