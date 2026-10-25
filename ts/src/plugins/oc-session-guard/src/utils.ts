/**
 * OC Session Guard — Utilities, regex definitions, messages, and formatting.
 *
 * @invariants
 * - All regular expressions centralized here
 * - All log messages and error formats centralized here
 * - Pure formatting functions only
 */

import type { CleanupReport } from "../../shared/session-cleanup.js";

// ── Centralized Regular Expressions ─────────────────────────────────

export const WHITESPACE_ONLY_REGEX = /^\s*$/;

export const HEARTBEAT_CONTEXT_GUIDANCE_REGEX =
  /Follow the heartbeat monitor scratch context when provided/i;

export const HEARTBEAT_OK_PROMPT_REGEX =
  /If nothing needs attention,\s*reply HEARTBEAT_OK/i;

export const HEARTBEAT_TOOL_PROMPT_REGEX =
  /Use heartbeat_respond to report the wake outcome/i;

export const HEARTBEAT_POLL_REGEX = /^\[OpenClaw heartbeat poll\]/i;

export const HEARTBEAT_SCHEDULED_TASKS_REGEX =
  /Run the following periodic tasks/i;

export const HEARTBEAT_COMMITMENTS_REGEX =
  /Due inferred follow-up commitments are available|Commitments:/i;

export const HEARTBEAT_EXEC_COMPLETION_REGEX =
  /Background task completed:|\[System Event\]/i;

export const HEARTBEAT_CRON_EVENT_REGEX = /Scheduled job|cron:/i;

export const HEARTBEAT_SCRATCH_DIRECTIVE_REGEX =
  /Heartbeat monitor scratch:\s*\S+/i;

// ── Centralized Messages ────────────────────────────────────────────

export const MESSAGES = {
  IDLE_PROMPT_BLOCKED_REASON:
    "Empty or whitespace-only prompt blocked — zero model calls when idle",
  IDLE_HEARTBEAT_BLOCKED_REASON:
    "Idle heartbeat suppressed — zero model calls when idle",
  IDLE_HEARTBEAT_LOG:
    "[oc-session-guard] Suppressed idle heartbeat turn: 0 model calls when idle",
  CLEANUP_FAILED_LOG: "[oc-session-guard] after_compaction failed: ",
  PURGE_FAILED_LOG: "[oc-session-guard] session_end failed: ",
  BEFORE_RUN_FAILED_LOG: "[oc-session-guard] before_agent_run failed: ",
  SESSIONS_NOT_FOUND: "sessions.json not found",
  HEALTH_CHECK_FAILED: "Health check failed: ",
  CLEANUP_MANUAL_FAILED: "Cleanup failed: ",
} as const;

// ── Centralized Formatters / Print Helpers ───────────────────────────

export function formatCleanupLog(report: CleanupReport): string {
  return (
    `[oc-session-guard] Cleanup: ${report.purgedCount} purged, ` +
    `${report.strippedFieldCount} fields stripped, ` +
    `${report.reductionPercent}% size reduction`
  );
}

export function formatPurgeLog(report: CleanupReport): string {
  return `[oc-session-guard] Purge: ${report.purgedCount} stale entries removed`;
}

export function formatHealthReport(params: {
  entryCount: number;
  subagentCount: number;
  sizeBytes: number;
}): string {
  return JSON.stringify(
    {
      ok: true,
      entryCount: params.entryCount,
      subagentCount: params.subagentCount,
      sizeBytes: params.sizeBytes,
      sizeKB: Math.round(params.sizeBytes / 1024),
    },
    null,
    2,
  );
}
