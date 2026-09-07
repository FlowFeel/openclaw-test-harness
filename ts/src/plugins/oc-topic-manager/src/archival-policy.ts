/**
 * archival-policy — decide what should happen to a topic.
 *
 * @behavior
 * Priority: archive (idle too long) > compact (too large) > leave.
 * Idle always wins so oversized-but-dead topics are archived, not
 * compacted into a bigger archive.
 *
 * @dft
 * - Pure: (TopicMeta, nowMs, thresholds) → ArchivalDecision.
 * - Decision branches in one switch/case on the computed state.
 */

import type { TopicMeta, ArchivalThresholds, ArchivalDecision } from "./types.js";

/** Milliseconds idle since the topic's last activity. Returns null when unknown. */
function idleMs(meta: TopicMeta, nowMs: number): number | null {
  if (!meta.lastActiveAt) return null;
  const last = Date.parse(meta.lastActiveAt);
  if (Number.isNaN(last)) return null;
  return Math.max(0, nowMs - last);
}

/** Enumerate the decision states in priority order. */
function stateFor(meta: TopicMeta, nowMs: number, t: ArchivalThresholds): string {
  const idle = idleMs(meta, nowMs);
  if (idle !== null && idle > t.maxIdleDays * 86_400_000) return "idle";
  if (meta.messageCount > t.maxMessages) return "oversized";
  return "healthy";
}

/**
 * Evaluate one topic against the thresholds.
 *
 * When last activity is unknown (lastActiveAt "" or unparseable), the idle
 * rule is NOT evaluated — an oversized topic still compacts, but a healthy-
 * looking topic is reported as "last activity unknown" rather than silently
 * "within thresholds", so a missing data source is visible in the report.
 */
export function decideArchival(
  meta: TopicMeta,
  nowMs: number,
  thresholds: ArchivalThresholds
): ArchivalDecision {
  const idle = idleMs(meta, nowMs);
  switch (stateFor(meta, nowMs, thresholds)) {
    case "idle":
      return { topicId: meta.id, action: "archive", reason: `idle > ${thresholds.maxIdleDays}d` };
    case "oversized":
      return { topicId: meta.id, action: "compact", reason: `messages > ${thresholds.maxMessages}` };
    default:
      return {
        topicId: meta.id,
        action: "leave",
        reason:
          idle === null
            ? "last activity unknown — idle rule not evaluated"
            : "within thresholds",
      };
  }
}