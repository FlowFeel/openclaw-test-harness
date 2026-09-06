/**
 * recovery-plan — build the concrete fix for an orphaned topic.
 *
 * @behavior
 * Produces the canonical OC session key for a Telegram forum topic
 * so the orphan can re-register with the right agent.
 *
 * @dft
 * - Pure: (TopicMeta, chatId, agentId) → RecoveryPlan.
 * - Key format isolated in one function.
 * - Validation throws with a rule name so callers can surface it.
 */

import type { TopicMeta, RecoveryPlan } from "./types.js";

/** Canonical OC session key for an agent bound to a forum topic. */
export function sessionKeyFor(agentId: string, chatId: string, topicId: number): string {
  return `agent:${agentId}:telegram:group:${chatId}:topic:${topicId}`;
}

/**
 * Build the registration plan for one orphaned topic.
 * Throws when agentId is empty — recovery without an agent is invalid.
 */
export function buildRecoveryPlan(
  topic: TopicMeta,
  chatId: string,
  agentId: string
): RecoveryPlan {
  if (!agentId) {
    throw new Error("agentId is required for recovery");
  }
  return {
    topicId: topic.id,
    chatId,
    agentId,
    sessionKey: sessionKeyFor(agentId, chatId, topic.id),
    action: "register",
  };
}