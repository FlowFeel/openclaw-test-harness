/**
 * sync-plan — pure decision core for topic-registry sync.
 *
 * @behavior
 * Combines forum truth (TopicMeta[]) with the session registry
 * (SessionRegistration[]) into one SyncPlan:
 *
 * - toRegister:    topics with no session registration.
 * - stale:         registered topics idle past maxIdleDays (activity
 *                  measured from lastActiveAt).
 * - healthyCount:  registered topics not stale.
 *
 * Deterministic: callers inject `now` (ms epoch) and maxIdleDays.
 *
 * @dft
 * - Pure: (topics, registrations, config) → SyncPlan. No I/O, no throws.
 * - Unknown activity (empty lastActiveAt) never counts as stale — we
 *   can't prove idleness without a timestamp, so we leave it alone.
 * - Reuses detectOrphans for the registration gap (no duplicated set
 *   logic).
 */

import { detectOrphans } from "./detect-orphans.js";
import type { SessionRegistration, SyncPlan, TopicMeta } from "./types.js";

export interface SyncPlanConfig {
  /** Days without activity before a topic counts as stale. */
  maxIdleDays: number;
  /** Epoch ms used as the reference "now" for age computation. */
  nowMs: number;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between the timestamp and now (floor, never negative). */
export function idleDaysFor(lastActiveAt: string, nowMs: number): number {
  const ts = Date.parse(lastActiveAt);
  if (!Number.isFinite(ts)) return 0;
  const diff = nowMs - ts;
  return diff > 0 ? Math.floor(diff / MS_PER_DAY) : 0;
}

/** True when a registered topic is stale (has activity, past threshold). */
export function isStale(
  topic: TopicMeta,
  cfg: SyncPlanConfig
): boolean {
  if (!topic.lastActiveAt) return false;
  return idleDaysFor(topic.lastActiveAt, cfg.nowMs) >= cfg.maxIdleDays;
}

/** Build the full sync plan from forum truth + registrations. */
export function buildSyncPlan(
  topics: TopicMeta[],
  registrations: SessionRegistration[],
  cfg: SyncPlanConfig
): SyncPlan {
  const report = detectOrphans(topics, registrations);
  const stale = topics
    .filter((t) => isStale(t, cfg))
    .map((t) => ({ topic: t, idleDays: idleDaysFor(t.lastActiveAt, cfg.nowMs) }));
  const staleIds = new Set(stale.map((s) => s.topic.id));
  const healthyCount = topics.filter(
    (t) => !report.orphaned.some((o) => o.id === t.id) && !staleIds.has(t.id)
  ).length;
  return {
    toRegister: report.orphaned,
    stale,
    healthyCount,
    totalTopics: topics.length,
    registeredCount: registrations.length,
  };
}