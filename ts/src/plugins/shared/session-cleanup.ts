/**
 * Session cleanup — pure logic for managing sessions.json bloat.
 *
 * @behavior
 * Reads sessions.json, strips bloat fields, purges stale subagent entries,
 * and writes the cleaned result back. All logic is pure (input → output,
 * no side effects) except for the actual file I/O which is in the server.
 *
 * @invariants
 * - `stripBloatFields` is pure: takes entries object, returns cleaned object.
 * - `purgeStaleSubagents` is pure: takes entries + cutoff time, returns cleaned.
 * - `computeCleanupReport` is pure: takes before/after, returns report.
 * - File I/O is in the server, not here.
 *
 * @dft
 * - All functions are testable without file system access.
 * - Deterministic: uses injected timestamp, not Date.now().
 * - No fixtures: data is inline in tests.
 */

import { SUBAGENT_KEY } from "./regex-library.ts";

// ── Types ─────────────────────────────────────────────────────

export interface SessionEntry {
  [key: string]: unknown;
}

export type SessionsMap = Record<string, SessionEntry>;

export interface CleanupOptions {
  bloatFields: string[];
  maxAgeHours: number;
  nowMs: number;
}

export interface CleanupReport {
  beforeCount: number;
  afterCount: number;
  purgedCount: number;
  strippedFieldCount: number;
  beforeBytes: number;
  afterBytes: number;
  reductionPercent: number;
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Strip bloat fields from all session entries.
 * Returns a NEW object (does not mutate input).
 */
export function stripBloatFields(
  sessions: SessionsMap,
  bloatFields: string[]
): { cleaned: SessionsMap; strippedCount: number } {
  let strippedCount = 0;
  const cleaned: SessionsMap = {};

  for (const [key, entry] of Object.entries(sessions)) {
    const cleanedEntry: SessionEntry = {};
    for (const [field, value] of Object.entries(entry)) {
      if (bloatFields.includes(field)) {
        strippedCount++;
      } else {
        cleanedEntry[field] = value;
      }
    }
    cleaned[key] = cleanedEntry;
  }

  return { cleaned, strippedCount };
}

/**
 * Purge stale subagent entries older than maxAgeHours.
 * Returns a NEW object with stale entries removed.
 */
export function purgeStaleSubagents(
  sessions: SessionsMap,
  opts: { maxAgeHours: number; nowMs: number }
): { cleaned: SessionsMap; purgedKeys: string[] } {
  const cutoffMs = opts.nowMs - opts.maxAgeHours * 60 * 60 * 1000;
  const purgedKeys: string[] = [];
  const cleaned: SessionsMap = {};

  for (const [key, entry] of Object.entries(sessions)) {
    // Only purge subagent sessions
    if (!SUBAGENT_KEY.test(key)) {
      cleaned[key] = entry;
      continue;
    }

    // Check if stale
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    const sessionStartedAt =
      typeof entry.sessionStartedAt === "number" ? entry.sessionStartedAt : 0;
    const lastActivity = Math.max(updatedAt, sessionStartedAt);

    if (lastActivity < cutoffMs) {
      purgedKeys.push(key);
    } else {
      cleaned[key] = entry;
    }
  }

  return { cleaned, purgedKeys };
}

/**
 * Compute a cleanup report from before/after states.
 */
export function computeCleanupReport(
  before: SessionsMap,
  after: SessionsMap,
  strippedCount: number
): CleanupReport {
  const beforeJson = JSON.stringify(before, null, 0);
  const afterJson = JSON.stringify(after, null, 0);
  const beforeBytes = Buffer.byteLength(beforeJson, "utf8");
  const afterBytes = Buffer.byteLength(afterJson, "utf8");

  return {
    beforeCount: Object.keys(before).length,
    afterCount: Object.keys(after).length,
    purgedCount: Object.keys(before).length - Object.keys(after).length,
    strippedFieldCount: strippedCount,
    beforeBytes,
    afterBytes,
    reductionPercent:
      beforeBytes > 0
        ? Math.round((1 - afterBytes / beforeBytes) * 100)
        : 0,
  };
}

/**
 * Full cleanup pipeline: strip bloat + purge stale.
 * Returns the cleaned sessions and a report.
 */
export function cleanupSessions(
  sessions: SessionsMap,
  opts: CleanupOptions
): { cleaned: SessionsMap; report: CleanupReport } {
  const { cleaned: stripped, strippedCount } = stripBloatFields(
    sessions,
    opts.bloatFields
  );
  const { cleaned: purged } = purgeStaleSubagents(stripped, {
    maxAgeHours: opts.maxAgeHours,
    nowMs: opts.nowMs,
  });
  const report = computeCleanupReport(sessions, purged, strippedCount);
  return { cleaned: purged, report };
}
