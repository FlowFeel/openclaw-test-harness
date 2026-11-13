/**
 * OC Session Guard — Pure logic for idle agent run admission.
 *
 * @invariants
 * - Pure logic: no direct I/O, no timers, zero auxiliary model calls
 * - Blocks automated heartbeat turns when no actionable tasks/commitments exist
 * - Preserves interactive user prompts and heartbeats with due tasks
 * - Uses early returns with no if-else-if chains
 */

import {
  WHITESPACE_ONLY_REGEX,
  HEARTBEAT_CONTEXT_GUIDANCE_REGEX,
  HEARTBEAT_OK_PROMPT_REGEX,
  HEARTBEAT_TOOL_PROMPT_REGEX,
  HEARTBEAT_POLL_REGEX,
  HEARTBEAT_SCHEDULED_TASKS_REGEX,
  HEARTBEAT_COMMITMENTS_REGEX,
  HEARTBEAT_EXEC_COMPLETION_REGEX,
  HEARTBEAT_CRON_EVENT_REGEX,
  HEARTBEAT_SCRATCH_DIRECTIVE_REGEX,
  MESSAGES,
} from "./utils.js";

export type AdmissionDecision =
  | { outcome: "pass" }
  | { outcome: "block"; reason: string };

export interface AdmissionContext {
  trigger?: string;
  isHeartbeat?: boolean;
}

/** Check if the prompt contains actionable periodic, exec, cron, or commitment work. */
export function hasActionableWork(prompt: string): boolean {
  if (HEARTBEAT_SCHEDULED_TASKS_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_COMMITMENTS_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_EXEC_COMPLETION_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_CRON_EVENT_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_SCRATCH_DIRECTIVE_REGEX.test(prompt)) {
    return true;
  }
  return false;
}

/** Check if the prompt matches default idle heartbeat prompt signatures. */
export function matchesIdleHeartbeatSignature(prompt: string): boolean {
  if (HEARTBEAT_CONTEXT_GUIDANCE_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_OK_PROMPT_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_TOOL_PROMPT_REGEX.test(prompt)) {
    return true;
  }
  if (HEARTBEAT_POLL_REGEX.test(prompt)) {
    return true;
  }
  return false;
}

/**
 * Evaluate whether an incoming agent run should be admitted or blocked.
 * Prevents automated LLM API calls when the instance is idle.
 */
export function evaluateAgentRunAdmission(
  prompt?: string,
  ctx?: AdmissionContext,
): AdmissionDecision {
  if (!prompt || WHITESPACE_ONLY_REGEX.test(prompt)) {
    return {
      outcome: "block",
      reason: MESSAGES.IDLE_PROMPT_BLOCKED_REASON,
    };
  }

  if (hasActionableWork(prompt)) {
    return { outcome: "pass" };
  }

  if (matchesIdleHeartbeatSignature(prompt)) {
    return {
      outcome: "block",
      reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
    };
  }

  const isHeartbeat =
    ctx?.trigger === "heartbeat" || ctx?.isHeartbeat === true;
  if (isHeartbeat) {
    return {
      outcome: "block",
      reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
    };
  }

  return { outcome: "pass" };
}
