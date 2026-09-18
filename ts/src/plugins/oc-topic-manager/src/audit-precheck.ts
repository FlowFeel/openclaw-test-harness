/**
 * audit-precheck — fail-loudly guard for topic_audit.
 *
 * @behavior
 * An audit against zero topics is meaningless and actively harmful: every
 * registered session diffed against an empty topic set gets reported
 * "unregistered". Production saw 240 phantom entries when a caller ran
 * topic_audit with an empty topics payload (2026-09-18, issue #31).
 *
 * @invariants
 * - Pure: no I/O, no node builtins.
 * - Deterministic: same inputs -> same verdict.
 * - Refuses (ok: false) whenever the topic set is empty, regardless of
 *   registration count — an empty audit is never a meaningful audit.
 *
 * @dft
 * - Tested with unit-audit-precheck.spec.ts: refusal paths, phantom-risk
 *   count surfaced, pass-through on non-empty topic sets.
 */

import type { TopicMeta } from "./types.js";

export interface AuditPrecheckResult {
  ok: boolean;
  /** Refusal reason; present only when ok === false. */
  error?: string;
  /** Registered sessions that would have been falsely reported "unregistered". */
  phantomRisk?: number;
}

/**
 * Guard: refuse to run an audit when the topic payload is empty.
 *
 * @param topics Parsed topic metadata (empty means "caller supplied nothing").
 * @param registrationCount Number of registered sessions the diff would touch.
 */
export function auditPrecheck(
  topics: TopicMeta[],
  registrationCount: number
): AuditPrecheckResult {
  if (topics.length === 0) {
    return {
      ok: false,
      phantomRisk: registrationCount,
      error:
        "topics payload is empty — refusing to audit. Pass the raw forum " +
        "topics payload ({topics:[...]}); auditing zero topics would falsely " +
        `report ${registrationCount} registered session(s) as unregistered ` +
        "(issue #31: 240 phantom entries in production).",
    };
  }
  return { ok: true };
}
