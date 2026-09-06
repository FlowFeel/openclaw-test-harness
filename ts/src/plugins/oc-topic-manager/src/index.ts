/**
 * oc-topic-manager — forum topic registry hygiene plugin.
 *
 * @behavior
 * Two tools, both thin shells over the pure core:
 * - topic_audit: parse topics, diff against registrations (injected, or read
 *   from the OC session registry when omitted), report orphans, stale
 *   registrations, and per-topic archival decisions.
 * - topic_recover: build the canonical registration plan for one orphaned
 *   topic. With apply=true, writes the registration into the registry
 *   (idempotent — an existing entry is refused, never overwritten).
 *
 * @invariants
 * - No OC core files modified.
 * - Topic payloads are caller-supplied (no Bot API network I/O here).
 * - Registry I/O is confined to registry-io; all decisions are pure.
 * - Pure logic lives in parse-topics / detect-orphans / archival-policy /
 *   recovery-plan / apply-recovery.
 *
 * @dft
 * - Tools return JSON strings so unit tests assert on data, not prose.
 * - Every failure path returns a text report, never throws.
 */

import { definePluginEntry, Type } from "../../shared/types.js";
import { parseTopics } from "./parse-topics.js";
import { detectOrphans } from "./detect-orphans.js";
import { decideArchival } from "./archival-policy.js";
import { buildRecoveryPlan, sessionKeyFor } from "./recovery-plan.js";
import { readRegistrations, writeRecoveryPlan } from "./registry-io.js";
import type {
  RecoveryApplication,
  SessionRegistration,
  TopicAuditReport,
} from "./types.js";

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
        "Compare Telegram forum topics against session registrations " +
        "(injected, or read from the OC session registry when omitted); " +
        "returns orphaned topics, unregistered sessions, and archival decisions.",
      parameters: Type.Object({
        topics: Type.Any({ description: "Raw forum topics payload ({topics:[...]}); entries may carry lastActiveAt (ISO) if the source derives it" }),
        registrations: Type.Optional(
          Type.Array(
            Type.Object({ topicId: Type.Number(), sessionKey: Type.String() }),
            { description: "Registered topic sessions. Omit to read from the OC session registry on disk." }
          )
        ),
        sessionsPath: Type.Optional(
          Type.String({ description: "Override path to sessions.json (defaults to the active agent's registry)" })
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const topics = parseTopics(params.topics);
        const registrations: SessionRegistration[] = Array.isArray(params.registrations)
          ? asRegistrations(params.registrations)
          : readRegistrations(
              typeof params.sessionsPath === "string" ? params.sessionsPath : undefined
            );
        const report: TopicAuditReport = {
          ...detectOrphans(topics, registrations),
          archivalDecisions: topics.map((t) => decideArchival(t, Date.now(), thresholds)),
        };
        return textResponse(report);
      },
    });

    api.registerTool({
      name: "topic_recover",
      description:
        "Build the canonical session key and registration plan for an " +
        "orphaned forum topic. With apply=true, registers it in the OC "+
        "session registry (idempotent). Default: plan only.",
      parameters: Type.Object({
        topicId: Type.Number({ description: "Forum topic id" }),
        title: Type.Optional(Type.String()),
        chatId: Type.String({ description: "Telegram chat id" }),
        agentId: Type.String({ description: "Agent to bind" }),
        apply: Type.Optional(
          Type.Any({ description: "When true, write the registration into the OC session registry (idempotent). Default false — plan only." })
        ),
        sessionsPath: Type.Optional(Type.String()),
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
        if (params.apply !== true) {
          return textResponse(plan);
        }
        const application: RecoveryApplication = writeRecoveryPlan(
          plan,
          typeof params.sessionsPath === "string" ? params.sessionsPath : undefined
        );
        return textResponse({ plan, application });
      },
    });

    api.logger?.info?.(
      `oc-topic-manager ready (thresholds: idle>${thresholds.maxIdleDays}d, msgs>${thresholds.maxMessages})`
    );
  },
});

export { sessionKeyFor };