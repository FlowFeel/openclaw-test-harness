/**
 * topic-health-logic — pure classification for topic health telemetry (T-584).
 *
 * @behavior
 * Inspects forum topic sessions in the OC session registry (sessions.json)
 * and classifies unhealthy topics:
 * - CRITICAL_CONTEXT_CEILING: contextTokens >= 240,000
 * - DEAD_TOPIC: status == "killed" or abortedLastRun == true
 * - ZOMBIE_RUNNING: status == "running" AND updatedAt older than 15 minutes (900,000 ms)
 * - UNCOMPACTED_BLOAT: active transcript .jsonl file larger than 2.0 MB (2 * 1024 * 1024 bytes)
 *
 * Assigns automated remediation recommendations:
 * - remedy: "materialize_successor" when CRITICAL_CONTEXT_CEILING is present
 * - remedy: "sanitize_transcript" when UNCOMPACTED_BLOAT or ZOMBIE_RUNNING is present (and no context ceiling)
 *
 * @invariants
 * - Pure: (sessions, fileSizes, nowMs) -> TopicHealthSummary.
 * - No direct filesystem or network I/O; file sizes are injected.
 * - Deterministic: same inputs produce identical verdicts and counts.
 * - Handles malformed, null, or missing fields defensively without throwing.
 *
 * @dft
 * - Pure logic isolated from filesystem seams for 100% unit test coverage.
 */

import { parseTopicSessionKey } from "./apply-recovery.js";
import type { SessionsMap } from "../../../shared/session-cleanup.js";
import type {
  TopicHealthIssue,
  TopicHealthEvaluation,
  TopicHealthSummary,
  TopicRemedy,
} from "./health-types.js";

export const CONTEXT_CEILING_THRESHOLD = 240_000;
export const ZOMBIE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes = 900,000 ms
export const UNCOMPACTED_BLOAT_BYTES = 2 * 1024 * 1024; // 2.0 MB = 2,097,152 bytes

export function evaluateTopicSessionHealth(
  topicId: number,
  sessionKey: string,
  entry: Record<string, unknown>,
  transcriptSizeBytes: number | undefined,
  nowMs: number
): TopicHealthEvaluation | null {
  const verdicts: TopicHealthIssue[] = [];

  const contextTokens = typeof entry.contextTokens === "number" ? entry.contextTokens : undefined;
  const status = typeof entry.status === "string" ? entry.status : undefined;
  const abortedLastRun = typeof entry.abortedLastRun === "boolean" ? entry.abortedLastRun : undefined;
  const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : undefined;

  // 1. CRITICAL_CONTEXT_CEILING: contextTokens >= 240,000
  if (contextTokens !== undefined && contextTokens >= CONTEXT_CEILING_THRESHOLD) {
    verdicts.push("CRITICAL_CONTEXT_CEILING");
  }

  // 2. DEAD_TOPIC: status == "killed" or abortedLastRun == true
  if (status === "killed" || abortedLastRun === true) {
    verdicts.push("DEAD_TOPIC");
  }

  // 3. ZOMBIE_RUNNING: status == "running" AND updatedAt older than 15 minutes
  if (status === "running") {
    if (updatedAt !== undefined && (nowMs - updatedAt) > ZOMBIE_TIMEOUT_MS) {
      verdicts.push("ZOMBIE_RUNNING");
    }
  }

  // 4. UNCOMPACTED_BLOAT: active transcript .jsonl file larger than 2.0 MB
  if (transcriptSizeBytes !== undefined && transcriptSizeBytes > UNCOMPACTED_BLOAT_BYTES) {
    verdicts.push("UNCOMPACTED_BLOAT");
  }

  if (verdicts.length === 0) {
    return null;
  }

  let remedy: TopicRemedy | undefined;
  if (verdicts.includes("CRITICAL_CONTEXT_CEILING")) {
    remedy = "materialize_successor";
  } else if (verdicts.includes("UNCOMPACTED_BLOAT") || verdicts.includes("ZOMBIE_RUNNING")) {
    remedy = "sanitize_transcript";
  }

  return {
    topicId,
    sessionKey,
    verdicts,
    remedy,
    metrics: {
      contextTokens,
      status,
      abortedLastRun,
      updatedAt,
      transcriptSizeBytes,
    },
  };
}

export function evaluateTopicsHealth(
  sessions: SessionsMap,
  fileSizes: Record<string, number>,
  nowMs: number
): TopicHealthSummary {
  const evaluations: TopicHealthEvaluation[] = [];
  const byIssue: Record<TopicHealthIssue, number> = {
    CRITICAL_CONTEXT_CEILING: 0,
    DEAD_TOPIC: 0,
    ZOMBIE_RUNNING: 0,
    UNCOMPACTED_BLOAT: 0,
  };

  let totalScanned = 0;

  for (const [sessionKey, entry] of Object.entries(sessions)) {
    if (typeof entry !== "object" || entry === null) continue;
    const parsed = parseTopicSessionKey(sessionKey);
    if (!parsed) continue;

    totalScanned++;
    const size = fileSizes[sessionKey];
    const evaluation = evaluateTopicSessionHealth(
      parsed.topicId,
      sessionKey,
      entry as Record<string, unknown>,
      size,
      nowMs
    );

    if (evaluation) {
      evaluations.push(evaluation);
      for (const verdict of evaluation.verdicts) {
        byIssue[verdict]++;
      }
    }
  }

  return {
    totalScanned,
    flaggedCount: evaluations.length,
    byIssue,
    evaluations,
  };
}
