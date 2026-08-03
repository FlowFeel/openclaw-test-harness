/**
 * OC Session Guard — session bloat management plugin.
 *
 * @behavior
 * Hooks into after_compaction and session_end to strip bloat fields
 * and purge stale subagent entries from sessions.json. No sidecar
 * process needed — direct file I/O.
 *
 * @invariants
 * - No OC core files modified
 * - All cleanup logic is pure (session-cleanup.ts)
 * - File I/O is in sessions-io.ts (injectable for tests)
 * - Hooks never block agent runs (catch errors, log, continue)
 *
 * @dft
 * - Pure logic tested without file system
 * - Injectable I/O functions
 * - Deterministic timestamps
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { cleanupSessions, type SessionsMap, type CleanupReport } from "../../shared/session-cleanup.js";
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "./sessions-io.js";

export interface SessionGuardConfig {
  maxAgeHours?: number;
  stripBloatFields?: boolean;
  bloatFields?: string[];
  sessionsPath?: string;
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
  description: "Session bloat management — strips bloat fields and purges stale subagents.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: SessionGuardConfig = (config as SessionGuardConfig) ?? {};
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxAgeHours = cfg.maxAgeHours ?? 15;
    const sessionsPath = cfg.sessionsPath;

    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) => writeSessions(data, path ?? sessionsPath);

    // ── Hook: after_compaction — strip bloat fields ─────────
    api.registerHook("after_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(
          `[oc-session-guard] Cleanup: ${report.purgedCount} purged, ` +
          `${report.strippedFieldCount} fields stripped, ` +
          `${report.reductionPercent}% size reduction`
        );
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] after_compaction failed: ${String(err)}`);
      }
    }, { name: "oc-session-guard-after-compaction" });

    // ── Hook: session_end — purge stale subagents ───────────
    api.registerHook("session_end", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(
          `[oc-session-guard] Purge: ${report.purgedCount} stale entries removed`
        );
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] session_end failed: ${String(err)}`);
      }
    }, { name: "oc-session-guard-session-end" });

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
              content: [{ type: "text" as const, text: "sessions.json not found" }],
            };
          }
          const count = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) => k.includes("subagent")).length;
          const size = JSON.stringify(raw).length;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                entryCount: count,
                subagentCount,
                sizeBytes: size,
                sizeKB: Math.round(size / 1024),
              }, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Health check failed: ${String(err)}` }],
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
              content: [{ type: "text" as const, text: "sessions.json not found" }],
            };
          }
          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours,
            nowMs: Date.now(),
          });
          writer(cleaned, sessionsPath);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Cleanup failed: ${String(err)}` }],
          };
        }
      },
    });
  },
});
