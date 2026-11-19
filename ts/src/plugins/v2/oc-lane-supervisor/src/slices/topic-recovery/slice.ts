/**
 * Topic Recovery & Session Maintenance Slice Adapter — binds session_health, session_cleanup,
 * topic_audit, topic_recover, after_compaction, and session_end.
 *
 * @invariants
 * - All session/registry I/O mediated via injectable SessionsReader/Writer protocols (A1/A5).
 *
 * @dft
 * - Tested via oc-lane-supervisor integration & manifest specs with InMemorySessionsStore.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import { cleanupSessions, type SessionsMap } from "../../../../../shared/session-cleanup.js";
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "../../sessions-io.js";
import { parseTopics } from "../../parse-topics.js";
import { detectOrphans } from "../../detect-orphans.js";
import { decideArchival } from "../../archival-policy.js";
import { buildRecoveryPlan } from "../../recovery-plan.js";
import { readRegistrations } from "../../registry-io.js";
import { applyRecoveryPlan } from "../../apply-recovery.js";
import { evaluateTopicsHealth } from "../../health-logic.js";
import { auditPrecheck } from "../../audit-precheck.js";
import { formatCleanupLog, formatPurgeLog, formatHealthReport, MESSAGES } from "../../utils.js";
import type { SessionRegistration } from "../../topic-manager-types.js";
import type { SessionReputation } from "../../../../../shared/efficiency-energy-logic.js";

export interface TopicRecoverySliceConfig {
  sessionsPath?: string;
  bloatFields: string[];
  maxAgeHours: number;
  maxIdleDays: number;
  maxMessages: number;
  sessionsReader?: SessionsReader;
  sessionsWriter?: SessionsWriter;
  clock?: () => number;
  getHealthCard: (sessionId: string) => { reputation?: SessionReputation; efficiencyCard?: string };
}

export interface TopicRecoverySliceHandle {
  onAfterCompaction: () => void;
  onSessionEnd: () => void;
}

function asRegistrations(value: unknown): SessionRegistration[] {
  if (!Array.isArray(value)) return [];
  const out: SessionRegistration[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { topicId?: unknown; sessionKey?: unknown };
    if (typeof rec.topicId === "number" && Number.isInteger(rec.topicId) && rec.topicId > 0 && typeof rec.sessionKey === "string") {
      out.push({ topicId: rec.topicId, sessionKey: rec.sessionKey });
    }
  }
  return out;
}

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function bindTopicRecoverySlice(
  api: PluginApi,
  config: TopicRecoverySliceConfig,
): TopicRecoverySliceHandle {
  const reader: SessionsReader = config.sessionsReader ?? ((p) => readSessions(p ?? config.sessionsPath));
  const writer: SessionsWriter = config.sessionsWriter ?? ((d, p) => writeSessions(d, p ?? config.sessionsPath));
  const clock = config.clock ?? (() => Date.now());

  function runCleanup(stripBloat: boolean): { ok: boolean; error?: string; report?: unknown } {
    const raw: SessionsMap | null = reader(config.sessionsPath);
    if (!raw) return { ok: false, error: MESSAGES.SESSIONS_NOT_FOUND };
    const { cleaned, report } = cleanupSessions(raw, {
      nowMs: clock(),
      maxAgeHours: config.maxAgeHours,
      bloatFields: stripBloat ? config.bloatFields : [],
    });
    writer(cleaned, config.sessionsPath);
    api.logger?.info?.(stripBloat ? formatCleanupLog(report) : formatPurgeLog(report));
    return { ok: true, report };
  }

  api.registerTool({
    name: "session_health",
    description: "Report sessions.json size, entry count, subagent count, and turn-energy habit telemetry.",
    parameters: Type.Object({ sessionId: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const raw = reader(config.sessionsPath);
      if (!raw) return jsonText({ ok: false, error: MESSAGES.SESSIONS_NOT_FOUND });
      const entries = Object.keys(raw);
      const subagentCount = entries.filter((k) => k.includes("subagent")).length;
      const sizeBytes = JSON.stringify(raw).length;
      const card = config.getHealthCard(typeof params.sessionId === "string" ? params.sessionId : "default");
      return {
        content: [{ type: "text" as const, text: formatHealthReport({ entryCount: entries.length, subagentCount, sizeBytes, ...card }) }],
      };
    },
  });

  api.registerTool({
    name: "session_cleanup",
    description: "Purge stale subagent entries and strip bloat fields from sessions.json.",
    parameters: Type.Object({}),
    async execute() {
      return jsonText(runCleanup(true));
    },
  });

  api.registerTool({
    name: "topic_audit",
    description: "Audit Telegram forum topics against registered OpenClaw topic sessions.",
    parameters: Type.Object({
      topics: Type.Optional(Type.Any()),
      registrations: Type.Optional(Type.Any()),
      health: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const topics = parseTopics(params.topics);
      const regs = params.registrations ? asRegistrations(params.registrations) : readRegistrations(config.sessionsPath);
      const precheck = auditPrecheck(topics, regs.length);
      if (!precheck.ok) return jsonText(precheck);

      const diff = detectOrphans(topics, regs);
      const nowMs = clock();
      const archival = topics.map((t) =>
        decideArchival(t, nowMs, {
          maxIdleDays: config.maxIdleDays,
          maxMessages: config.maxMessages,
        }),
      );
      const sessions = reader(config.sessionsPath) ?? {};
      const health = params.health === true ? evaluateTopicsHealth(sessions, {}, nowMs) : undefined;
      return jsonText({ ...diff, archival, ...(health ? { health } : {}) });
    },
  });

  api.registerTool({
    name: "topic_recover",
    description: "Build or apply a deterministic recovery plan for an unregistered Telegram forum topic.",
    parameters: Type.Object({
      topicId: Type.Number(),
      chatId: Type.String(),
      agentId: Type.Optional(Type.String()),
      apply: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const topicId = Number(params.topicId);
      const chatId = String(params.chatId);
      const agentId = typeof params.agentId === "string" ? params.agentId : "main";
      const plan = buildRecoveryPlan(
        { id: topicId, title: `topic:${topicId}`, messageCount: 0, lastActiveAt: "", pinned: false },
        chatId,
        agentId,
      );
      if (params.apply === true) {
        const currentSessions = reader(config.sessionsPath) ?? {};
        const { updated, report } = applyRecoveryPlan(plan, currentSessions, clock());
        if (report.applied) writer(updated, config.sessionsPath);
        return jsonText({ ...plan, applied: report });
      }
      return jsonText(plan);
    },
  });

  return {
    onAfterCompaction() {
      try {
        runCleanup(true);
      } catch (err) {
        api.logger?.warn?.(`${MESSAGES.CLEANUP_FAILED_LOG}${String(err)}`);
      }
    },
    onSessionEnd() {
      try {
        runCleanup(false);
      } catch (err) {
        api.logger?.warn?.(`${MESSAGES.PURGE_FAILED_LOG}${String(err)}`);
      }
    },
  };
}
