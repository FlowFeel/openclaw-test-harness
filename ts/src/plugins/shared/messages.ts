/**
 * Messages Library — Centralized prompt cues, signposts, banners, and system messages.
 *
 * @dft principle: Messages and user-facing prompt strings reside in utils/messages files.
 * This guarantees consistency, localization capability, and clear separation from logic.
 */

export const SHARED_MESSAGES = {
  SIGNPOST_PREFIX:
    "# [SIGNPOST] May be out of date; the current version is kept in memory:",
  DEGRADED_STATE_WARNING:
    "[telemetry] System running in degraded state: event loop or memory pressure detected.",
  ADMISSION_DENIED:
    "Admission denied: system is overloaded or at capacity.",
  INVALID_PAYLOAD:
    "Invalid payload: input validation failed.",
  CIRCUIT_OPEN:
    "Circuit breaker is OPEN: rejecting downstream request.",
  TASK_PLANE_SHUTDOWN:
    "[oc-task-plane] TaskPlane shutdown complete.",
} as const;

export function formatSignpost(source: string, content: string): string {
  return `${SHARED_MESSAGES.SIGNPOST_PREFIX} ${source}\n\n${content}`;
}

export function formatCue(pointer: string, context?: string): string {
  if (context) {
    return `[see ${pointer} (${context})]`;
  }
  return `[see ${pointer}]`;
}
