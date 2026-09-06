/**
 * detect-orphans — compare forum topics against the session registry.
 *
 * @behavior
 * Two failure directions from the topic-registration-loss war story:
 * 1. Topic exists but no session registered  → orphaned.
 * 2. Session registered but topic is gone    → unregistered.
 *
 * @dft
 * - Pure: (TopicMeta[], SessionRegistration[]) → OrphanReport.
 * - Set logic via Map for O(n+m), no nested functions.
 */

import type {
  TopicMeta,
  SessionRegistration,
  OrphanReport,
} from "./types.js";

/** Ids present in the registration list. */
function registeredIds(sessions: SessionRegistration[]): Set<number> {
  const ids = new Set<number>();
  for (const s of sessions) ids.add(s.topicId);
  return ids;
}

/** Ids present in the forum topic list. */
function forumIds(topics: TopicMeta[]): Set<number> {
  const ids = new Set<number>();
  for (const t of topics) ids.add(t.id);
  return ids;
}

/**
 * Compare both directions and return the mismatch report.
 */
export function detectOrphans(
  topics: TopicMeta[],
  sessions: SessionRegistration[]
): OrphanReport {
  const registered = registeredIds(sessions);
  const inForum = forumIds(topics);

  const orphaned = topics.filter((t) => !registered.has(t.id));
  const unregistered = sessions.filter((s) => !inForum.has(s.topicId));

  return { orphaned, unregistered };
}