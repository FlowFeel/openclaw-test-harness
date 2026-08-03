/**
 * OC Compaction Helper — transcript compaction assistance plugin.
 *
 * @behavior
 * Hooks into before_agent_reply (throttled) and after_compaction to
 * provide compaction assistance. before_agent_reply strips bloat fields
 * on a 60s throttle — only reads/writes when bloat exceeds 10KB.
 * after_compaction is registered but OC's runtime may not dispatch it.
 * Also provides a compact_check tool for ad-hoc size estimates.
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
import { cleanupSessions, type SessionsMap } from "../../shared/session-cleanup.js";
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "./sessions-io.js";

export interface CompactionHelperConfig {
  maxTranscriptMb?: number;
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
  id: "oc-compaction-helper",
  name: "OC Compaction Helper",
  description: "Transcript compaction helper — warns on large transcripts, strips bloat after compaction, reports size estimates.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: CompactionHelperConfig = (config as CompactionHelperConfig) ?? {};
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxTranscriptMb = cfg.maxTranscriptMb ?? 5;
    const sessionsPath = cfg.sessionsPath;

    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) => writeSessions(data, path ?? sessionsPath);

    // ── Hook: before_compaction — warn on large transcripts ──
    api.registerHook("before_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const sizeBytes = JSON.stringify(raw).length;
        const sizeMb = Math.round(sizeBytes / (1024 * 1024) * 100) / 100;
        if (sizeMb >= maxTranscriptMb) {
          api.logger?.warn?.(
            `[oc-compaction-helper] Transcript is ${sizeMb} MB — ` +
            `exceeds maxTranscriptMb threshold of ${maxTranscriptMb} MB. ` +
            `Compaction may reduce bloat.`
          );
        } else {
          api.logger?.info?.(
            `[oc-compaction-helper] Transcript is ${sizeMb} MB — within threshold.`
          );
        }
      } catch (err) {
        api.logger?.error?.(`[oc-compaction-helper] before_compaction failed: ${String(err)}`);
      }
    }, { name: "compaction-helper-before" });

    // ── Hook: before_agent_reply — strip bloat fields (throttled) ──
    // OC only dispatches before_agent_reply and before_compaction through
    // the hook runner. agent_end and after_compaction are SDK types but
    // OC's runtime doesn't fire them as plugin hooks.
    //
    // before_agent_reply fires every turn. To avoid per-turn file I/O,
    // we throttle: check file mtime, only read+strip if the file was
    // modified more than throttleMs ago AND bloat threshold is exceeded.
    // This means at most one read+write per throttleMs window.
    const throttleMs = 60_000; // 1 minute minimum between cleanup passes
    let lastCleanupMs = 0;

    api.registerHook("before_agent_reply", async () => {
      try {
        const now = Date.now();
        if (now - lastCleanupMs < throttleMs) return; // throttled — skip

        const raw = reader(sessionsPath);
        if (!raw) return;

        // Quick in-memory check: are bloat fields present?
        let hasBloat = false;
        let bloatBytes = 0;
        for (const entry of Object.values(raw)) {
          if (typeof entry === "object" && entry !== null) {
            for (const field of bloatFields) {
              if (field in entry) {
                hasBloat = true;
                bloatBytes += JSON.stringify(entry[field]).length;
              }
            }
          }
        }
        if (!hasBloat) { lastCleanupMs = now; return; }

        // Only write if bloat exceeds 10KB — avoids tiny writes
        if (bloatBytes < 10_000) { lastCleanupMs = now; return; }

        // Bloat found — strip and write
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours: 24,
          nowMs: now,
        });
        writer(cleaned, sessionsPath);
        lastCleanupMs = now;
        api.logger?.info?.(
          `[oc-compaction-helper] before_agent_reply cleanup: ` +
          `${report.strippedFieldCount} fields stripped, ` +
          `${report.reductionPercent}% size reduction`
        );
      } catch (err) {
        api.logger?.error?.(`[oc-compaction-helper] before_agent_reply cleanup failed: ${String(err)}`);
      }
    }, { name: "compaction-helper-before-reply" });

    // ── Hook: after_compaction — strip bloat fields (may not fire in OC runtime) ──
    api.registerHook("after_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours: 24,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(
          `[oc-compaction-helper] After compaction cleanup: ` +
          `${report.strippedFieldCount} fields stripped, ` +
          `${report.reductionPercent}% size reduction`
        );
      } catch (err) {
        api.logger?.error?.(`[oc-compaction-helper] after_compaction failed: ${String(err)}`);
      }
    }, { name: "compaction-helper-after" });

    // ── Tool: compact_check ──────────────────────────────────
    api.registerTool({
      name: "compact_check",
      description:
        "Check transcript size estimate and get compaction recommendation. " +
        "Reports current session size in MB, entry count, and whether " +
        "compaction is recommended.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) {
            return {
              content: [{ type: "text" as const, text: "sessions.json not found — no transcript data available." }],
            };
          }
          const sizeBytes = JSON.stringify(raw).length;
          const sizeMb = Math.round(sizeBytes / (1024 * 1024) * 100) / 100;
          const entryCount = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) => k.includes("subagent")).length;
          const needsCompaction = sizeMb >= maxTranscriptMb;

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                sizeMb,
                sizeBytes,
                entryCount,
                subagentCount,
                thresholdMb: maxTranscriptMb,
                needsCompaction,
                recommendation: needsCompaction
                  ? `Transcript is ${sizeMb} MB (threshold: ${maxTranscriptMb} MB). ` +
                    "Consider triggering compaction to reduce bloat."
                  : `Transcript is ${sizeMb} MB (threshold: ${maxTranscriptMb} MB). ` +
                    "No compaction needed at this time.",
              }, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `compact_check failed: ${String(err)}` }],
          };
        }
      },
    });
  },
});