/**
 * oc-topic-manager — forum topic registry hygiene plugin.
 *
 * @behavior
 * Two tools, both thin shells over the pure core:
 * - topic_audit: parse topics + registrations, report orphans and
 *   stale registrations (topic-registration-loss war story).
 * - topic_recover: build the canonical registration plan for one
 *   orphaned topic.
 *
 * @invariants
 * - No OC core files modified.
 * - No network I/O here: callers supply topic payloads and the
 *   registration list (source injection happens upstream).
 * - Pure logic lives in parse-topics / detect-orphans / recovery-plan.
 *
 * @dft
 * - Tools return JSON strings so unit tests assert on data, not prose.
 * - Every failure path returns a text report, never throws.
 */

import { definePluginEntry, Type } from "../../shared/types.js";
import { parseTopics } from "./parse-topics.js";
import { detectOrphans } from "./detect-orphans.js";
import { buildRecoveryPlan, sessionKeyFor } from "./recovery-plan.js";
import type { SessionRegistration } from "./types.js";

/** Extract a positive integer topic id, or null. */
function asTopicId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

/** Extract a registration list, dropping malformed entries. */
function asRegistrations(value: unknown): SessionRegistration[] {
  if (!Array.isArray(value)) return [];
  const out: SessionRegistration[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { topicId?: unknown; sessionKey?: unknown };
    const topicId = asTopicId(rec.topicId);
    if (topicId === null || typeof rec.sessionKey !== "string") continue;
    out.push({ topicId, sessionKey: rec.sessionKey });
  }
  return out;
}

/** Wrap a value as a tool text response. */
function textResponse(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export default definePluginEntry({
  id: "oc-topic-manager",
  name: "OC Topic Manager",
  description: "Forum topic registry hygiene — orphan detection and recovery planning.",
  register(api, config) {
    const thresholds = {
      maxIdleDays: Number(config?.maxIdleDays ?? 14),
      maxMessages: Number(config?.maxMessages ?? 2000),
    };

    api.registerTool({
      name: "topic_audit",
      description:
        "Compare Telegram forum topics against session registrations; " +
        "returns orphaned topics and unregistered sessions.",
      parameters: Type.Object({
        topics: Type.Any({ description: "Raw forum topics payload ({topics:[...]})" }),
        registrations: Type.Array(
          Type.Object({ topicId: Type.Number(), sessionKey: Type.String() }),
          { description: "Registered topic sessions" }
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const topics = parseTopics(params.topics);
        const report = detectOrphans(topics, asRegistrations(params.registrations));
        return textResponse(report);
      },
    });

    api.registerTool({
      name: "topic_recover",
      description:
        "Build the canonical session key and registration plan for an " +
        "orphaned forum topic. Returns the plan; does not register it.",
      parameters: Type.Object({
        topicId: Type.Number({ description: "Forum topic id" }),
        title: Type.Optional(Type.String()),
        chatId: Type.String({ description: "Telegram chat id" }),
        agentId: Type.String({ description: "Agent to bind" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const topicId = asTopicId(params.topicId);
        const chatId = typeof params.chatId === "string" ? params.chatId : "";
        const agentId = typeof params.agentId === "string" ? params.agentId : "";
        if (topicId === null || !chatId || !agentId) {
          return textResponse({ error: "invalid input: need numeric topicId, chatId, agentId" });
        }
        const title = typeof params.title === "string" ? params.title : "";
        const plan = buildRecoveryPlan(
          { id: topicId, title, messageCount: 0, lastActiveAt: "", pinned: false },
          chatId,
          agentId
        );
        return textResponse(plan);
      },
    });

    api.logger?.info?.(
      `oc-topic-manager ready (thresholds: idle>${thresholds.maxIdleDays}d, msgs>${thresholds.maxMessages})`
    );
  },
});

export { sessionKeyFor };