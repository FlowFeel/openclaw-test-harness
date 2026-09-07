/**
 * apply-recovery — pure registry mutation for recovery plans.
 *
 * @behavior
 * Three responsibilities, all pure:
 * 1. `parseTopicSessionKey` — recognize OC topic session keys of the shape
 *    `agent:<agentId>:telegram:group:<chatId>:topic:<topicId>` (the same
 *    grammar `sessionKeyFor` emits; contract-pinned in
 *    tests/oc-source/topic-session-key-contract.spec.ts).
 * 2. `registrationsFromSessions` — project a full sessions.json map down to
 *    the topic registrations the audit diff needs.
 * 3. `applyRecoveryPlan` — insert (or refuse) a recovery plan's entry,
 *    returning the updated map PLUS an A6 report. The caller persists the
 *    returned map; this module never touches the filesystem.
 *
 * @dft
 * - Pure: (input, input, injected nowMs) → output. No imports beyond types.
 * - The updated map is returned, never written — I/O lives in registry-io.
 * - Idempotent: a plan whose key already exists is refused with a reason,
 *   never a silent rewrite of an existing entry.
 */

import type {
  RecoveryApplication,
  RecoveryPlan,
  SessionRegistration,
} from "./types.js";
import type { SessionsMap } from "../../shared/session-cleanup.ts";

/** Matches `agent:<agentId>:telegram:group:<chatId>:topic:<topicId>`. */
const TOPIC_KEY_RE =
  /^agent:([^:]+):telegram:group:(-?\d+):topic:(\d+)$/;

/** True when the value looks like a malformed entry (non-object). */
function isEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** Parse one session key; null when it is not an OC telegram topic key. */
export function parseTopicSessionKey(
  key: string
): { agentId: string; chatId: string; topicId: number } | null {
  const match = TOPIC_KEY_RE.exec(key);
  if (!match) return null;
  return { agentId: match[1], chatId: match[2], topicId: Number(match[3]) };
}

/**
 * Project a sessions map down to topic registrations. Non-topic keys are
 * skipped; malformed entries are skipped (defensive, never throws).
 */
export function registrationsFromSessions(
  sessions: SessionsMap
): SessionRegistration[] {
  const out: SessionRegistration[] = [];
  for (const [key, entry] of Object.entries(sessions)) {
    if (!isEntry(entry)) continue;
    const parsed = parseTopicSessionKey(key);
    if (parsed === null) continue;
    out.push({ topicId: parsed.topicId, sessionKey: key });
  }
  return out;
}

/**
 * Apply a recovery plan to a sessions map.
 *
 * Returns the UPDATED map (caller persists it) and an A6 report. When the
 * sessionKey already exists, the map is returned unmodified and the report
 * refuses with a reason — recovery is idempotent, never a blind overwrite.
 */
export function applyRecoveryPlan(
  plan: RecoveryPlan,
  sessions: SessionsMap,
  nowMs: number
): { updated: SessionsMap; report: RecoveryApplication } {
  const before: "absent" | "present" =
    isEntry(sessions[plan.sessionKey]) ? "present" : "absent";

  if (before === "present") {
    return {
      updated: sessions,
      report: {
        topicId: plan.topicId,
        sessionKey: plan.sessionKey,
        applied: false,
        created: false,
        before,
        after: "registered",
        reason: "already registered",
      },
    };
  }

  const updated: SessionsMap = {
    ...sessions,
    [plan.sessionKey]: {
      topicId: plan.topicId,
      chatId: plan.chatId,
      agentId: plan.agentId,
      // Injected clock value, stored numerically — the pure layer never
      // constructs Date objects (A2); ISO formatting happens in registry-io.
      registeredAtMs: nowMs,
      source: "oc-topic-manager",
    },
  };

  return {
    updated,
    report: {
      topicId: plan.topicId,
      sessionKey: plan.sessionKey,
      applied: true,
      created: true,
      before,
      after: "registered",
    },
  };
}
