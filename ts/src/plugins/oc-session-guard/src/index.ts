/**
 * OC Session Guard — session bloat and idle admission management plugin.
 *
 * @behavior
 * - Hooks into after_compaction and session_end to strip bloat fields
 *   and purge stale subagent entries from sessions.json.
 * - Hooks into before_agent_run to intercept and suppress idle heartbeat
 *   turns, guaranteeing zero model calls when the instance is idle.
 * - Hooks into tool_result_persist to truncate oversized tool results
 *   (head 800 + tail 800 elision with omission notice) and compact zero-delta poll frames.
 * - Hooks into before_message_write to suppress consecutive identical poll frames.
 *
 * @invariants
 * - No OC core files modified
 * - Pure logic in idle-guard-logic.ts, tool-result-hygiene-logic.ts, poll-hygiene-logic.ts, and session-cleanup.ts
 * - Regexes, messages, and formatters in utils.ts
 * - File I/O in sessions-io.ts (injectable for tests)
 * - Zero auxiliary model calls
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { cleanupSessions } from "../../shared/session-cleanup.js";
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "./sessions-io.js";
import { evaluateAgentRunAdmission } from "./idle-guard-logic.js";
import {
  applyToolResultTruncation,
  type TruncationOptions,
} from "./tool-result-hygiene-logic.js";
import {
  compactZeroDeltaPollMessage,
  evaluateMessageWriteSuppression,
  createInitialPollDeduplicationState,
  type PollDeduplicationState,
} from "./poll-hygiene-logic.js";
import {
  formatCleanupLog,
  formatPurgeLog,
  formatHealthReport,
  MESSAGES,
} from "./utils.js";

export interface SessionGuardConfig extends TruncationOptions {
  maxAgeHours?: number;
  stripBloatFields?: boolean;
  bloatFields?: string[];
  sessionsPath?: string;
  suppressIdleHeartbeats?: boolean;
  enablePollDeduplication?: boolean;
}

const DEFAULT_BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

export default definePluginEntry({
  id: "oc-session-guard",
  name: "OC Session Guard",
  description:
    "Session bloat, idle admission guard & tool result hygiene — strips bloat fields, purges stale subagents, blocks idle model calls, truncates oversized tool outputs, and collapses poll loops.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: SessionGuardConfig = (config as SessionGuardConfig) ?? {};
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxAgeHours = cfg.maxAgeHours ?? 15;
    const sessionsPath = cfg.sessionsPath;
    const suppressIdle = cfg.suppressIdleHeartbeats ?? true;
    const enablePollDedup = cfg.enablePollDeduplication ?? true;

    const truncationOptions: TruncationOptions = {
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
      maxToolResultChars: cfg.maxToolResultChars,
      exemptTools: cfg.exemptTools,
    };

    let pollDedupState: PollDeduplicationState = createInitialPollDeduplicationState();

    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) =>
      writeSessions(data, path ?? sessionsPath);

    // ── Hook: tool_result_persist — head/tail truncation & poll compaction ──
    api.on("tool_result_persist", (event: unknown, ctx?: unknown) => {
      try {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return event;
        }

        const ev = event as { message: Record<string, unknown>; toolName?: string };
        const toolName = ev.toolName ?? (ev.message?.toolName as string | undefined);

        // 1. First check zero-delta poll compaction
        const pollResult = compactZeroDeltaPollMessage(ev.message, toolName);
        let currentMessage = pollResult.changed ? pollResult.message : ev.message;

        // 2. Apply head/tail truncation
        const truncResult = applyToolResultTruncation(currentMessage, toolName, truncationOptions);
        if (truncResult.changed) {
          currentMessage = truncResult.message;
        }

        return { message: currentMessage };
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] tool_result_persist error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_message_write — zero-delta poll frame suppression ──
    api.on("before_message_write", (event: unknown) => {
      if (!enablePollDedup) {
        return event;
      }
      try {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return event;
        }
        const ev = event as { message: Record<string, unknown> };
        const msg = ev.message;

        // Only process toolResult messages for poll suppression
        if (msg.role !== "toolResult") {
          pollDedupState = createInitialPollDeduplicationState();
          return event;
        }

        const toolName = msg.toolName as string | undefined;
        const suppression = evaluateMessageWriteSuppression(msg, pollDedupState, toolName);
        pollDedupState = suppression.nextState;

        if (suppression.block) {
          api.logger?.debug?.(`[oc-session-guard] suppressed consecutive zero-delta poll frame (count=${pollDedupState.suppressedPollCount})`);
          return { block: true };
        }

        if (suppression.message) {
          return { message: suppression.message };
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] before_message_write error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_agent_run — suppress idle model calls ──
    api.on("before_agent_run", async (event: unknown, ctx?: unknown) => {
      if (!suppressIdle) {
        return { outcome: "pass" };
      }
      try {
        const prompt =
          event && typeof event === "object" && "prompt" in event
            ? String((event as { prompt?: unknown }).prompt ?? "")
            : "";
        const trigger =
          ctx && typeof ctx === "object" && "trigger" in ctx
            ? String((ctx as { trigger?: unknown }).trigger ?? "")
            : "";
        const decision = evaluateAgentRunAdmission(prompt, { trigger });
        if (decision.outcome === "block") {
          api.logger?.info?.(MESSAGES.IDLE_HEARTBEAT_LOG);
        }
        return decision;
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.BEFORE_RUN_FAILED_LOG}${String(err)}`);
        return { outcome: "pass" };
      }
    });

    // ── Hook: after_compaction — strip bloat fields ─────────
    api.on("after_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatCleanupLog(report));
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.CLEANUP_FAILED_LOG}${String(err)}`);
      }
    });

    // ── Hook: session_end — purge stale subagents ───────────
    api.on("session_end", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatPurgeLog(report));
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.PURGE_FAILED_LOG}${String(err)}`);
      }
    });

    // ── Tool: session_health ────────────────────────────────
    api.registerTool({
      name: "session_health",
      description:
        "Check sessions.json health — file size, entry count, subagent count. " +
        "Run before and after compaction to monitor bloat.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) {
            return {
              content: [
                { type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND },
              ],
            };
          }
          const count = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) =>
            k.includes("subagent"),
          ).length;
          const size = JSON.stringify(raw).length;
          return {
            content: [
              {
                type: "text" as const,
                text: formatHealthReport({
                  entryCount: count,
                  subagentCount,
                  sizeBytes: size,
                }),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${MESSAGES.HEALTH_CHECK_FAILED}${String(err)}`,
              },
            ],
          };
        }
      },
    });

    // ── Tool: session_cleanup ────────────────────────────────
    api.registerTool({
      name: "session_cleanup",
      description:
        "Run session cleanup manually — strip bloat fields and purge stale subagents. " +
        "Returns a report of what was cleaned.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) {
            return {
              content: [
                { type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND },
              ],
            };
          }
          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours,
            nowMs: Date.now(),
          });
          writer(cleaned, sessionsPath);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(report, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${MESSAGES.CLEANUP_MANUAL_FAILED}${String(err)}`,
              },
            ],
          };
        }
      },
    });
  },
});
