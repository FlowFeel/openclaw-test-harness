/**
 * OC Compaction Helper — transcript compaction assistance plugin.
 *
 * @behavior
 * Hooks into before_prompt_build (fires every turn) to strip bloat fields
 * from sessions.json before they get injected into model context. Also hooks
 * into after_compaction for a deeper cleanup when compaction occurs. Provides
 * a compact_check tool for ad-hoc transcript size estimates.
 *
 * The key insight from OC source analysis: before_compaction and after_compaction
 * only fire when tokens hit the compaction threshold (976K). before_prompt_build
 * fires on every turn before the prompt is assembled — the right frequency for
 * bloat that accumulates on every turn.
 *
 * Throttling: in-memory timestamp check avoids file I/O on every turn. Only
 * reads+writes when bloat exceeds 10KB AND 60s has passed since last cleanup.
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
 * - Deterministic timestamps (injected clock)
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { shouldOffload, estimatePayloadBytes } from "../../shared/sidecar-router.js";
import { type SidecarProtocol, NullSidecar } from "../../shared/sidecar-protocol.js";
import { writeFileSync as fsWriteFileSync } from "node:fs";
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
  /** Sidecar protocol for CPU offloading (injected by gateway). */
  sidecar?: SidecarProtocol;
  /** Minimum milliseconds between bloat cleanup passes. Default: 60000 (1 min). */
  throttleMs?: number;
  /** Minimum bloat size in bytes before triggering a write. Default: 10240 (10KB). */
  bloatThresholdBytes?: number;
}

const DEFAULT_BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

/** Default throttle: 1 minute between cleanup passes. */
const DEFAULT_THROTTLE_MS = 60_000;

/** Default bloat threshold: 10KB before triggering a write. */
const DEFAULT_BLOAT_THRESHOLD = 10_240;

export default definePluginEntry({
  id: "oc-compaction-helper",
  name: "OC Compaction Helper",
  description:
    "Transcript compaction helper — strips bloat before prompt build, " +
    "warns on large transcripts, reports size estimates.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: CompactionHelperConfig = (config as CompactionHelperConfig) ?? {};
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxTranscriptMb = cfg.maxTranscriptMb ?? 5;
    const sessionsPath = cfg.sessionsPath;
    const throttleMs = cfg.throttleMs ?? DEFAULT_THROTTLE_MS;
    const bloatThresholdBytes = cfg.bloatThresholdBytes ?? DEFAULT_BLOAT_THRESHOLD;
    const sidecar: SidecarProtocol = cfg.sidecar ?? new NullSidecar();
    // Sidecar-aware writer: offloads JSON.stringify when beneficial
    const sidecarWriter: SessionsWriter = (data, path) => {
      const payloadBytes = estimatePayloadBytes(data);
      const decision = shouldOffload({
        operation: "serialize.session",
        payloadBytes,
        sidecarAvailable: sidecar.isAvailable(),
        poolFull: sidecar.getStats().active >= sidecar.getStats().poolSize,
      });
      if (decision.offload) {
        api.logger?.info?.(`[oc-compaction-helper] ${decision.rationale}`);
        sidecar.exec("serialize.session", { session: data }).then((result) => {
          if (typeof result === "string") {
            fsWriteFileSync(path ?? sessionsPath ?? "", result);
          } else {
            writeSessions(data, path ?? sessionsPath);
          }
        }).catch(() => writeSessions(data, path ?? sessionsPath));
      } else {
        writeSessions(data, path ?? sessionsPath);
      }
    };

// Sidecar-aware I/O: reader stays inline (small reads), writer offloads JSON.stringify
    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) => writeSessions(data, path ?? sessionsPath);

    // ── Throttle state (in-memory, no file I/O for the check itself) ──
    let lastCleanupMs = 0;

    // ── Hook: before_prompt_build — strip bloat fields (throttled) ──
    // Fires on every turn, before OC assembles the model prompt.
    // This is the optimal position: strip bloat BEFORE it gets injected
    // into model context, saving tokens per turn.
    api.on(
      "before_prompt_build",
      async () => {
        try {
          const now = Date.now();
          if (now - lastCleanupMs < throttleMs) return;

          const raw = reader(sessionsPath);
          if (!raw) return;

          // Quick in-memory scan: are bloat fields present?
          let hasBloat = false;
          let bloatBytes = 0;
          for (const entry of Object.values(raw)) {
            if (typeof entry === "object" && entry !== null) {
              for (const field of bloatFields) {
                if (field in entry) {
                  hasBloat = true;
                  const fieldValue = (entry as Record<string, unknown>)[field];
                  bloatBytes += JSON.stringify(fieldValue).length;
                }
              }
            }
          }

          if (!hasBloat) {
            lastCleanupMs = now;
            return;
          }

          // Only write if bloat exceeds threshold — avoids tiny writes
          if (bloatBytes < bloatThresholdBytes) {
            lastCleanupMs = now;
            return;
          }

          // Bloat found — strip and write atomically
          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours: 24,
            nowMs: now,
          });
          sidecarWriter(cleaned, sessionsPath);
          lastCleanupMs = now;
          api.logger?.info?.(
            `[oc-compaction-helper] before_prompt_build cleanup: ` +
              `${report.strippedFieldCount} fields stripped, ` +
              `${report.reductionPercent}% size reduction`
          );
        } catch (err) {
          api.logger?.error?.(
            `[oc-compaction-helper] before_prompt_build cleanup failed: ${String(err)}`
          );
        }
      }
    );

    // ── Hook: before_compaction — warn on large transcripts ──
    api.on(
      "before_compaction",
      async () => {
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
          api.logger?.error?.(
            `[oc-compaction-helper] before_compaction failed: ${String(err)}`
          );
        }
      }
    );

    // ── Hook: agent_end — strip bloat fields after turn completes ──
    // Fires when the conversation turn completes. This is the post-turn
    // cleanup: strip bloat that OC re-injected during the turn, so the
    // file is clean for the next turn. Uses the same throttle as
    // before_prompt_build to avoid redundant writes.
    api.on(
      "agent_end",
      async () => {
        try {
          const now = Date.now();
          if (now - lastCleanupMs < throttleMs) return;

          const raw = reader(sessionsPath);
          if (!raw) return;

          // Quick in-memory scan
          let hasBloat = false;
          let bloatBytes = 0;
          for (const entry of Object.values(raw)) {
            if (typeof entry === "object" && entry !== null) {
              for (const field of bloatFields) {
                if (field in entry) {
                  hasBloat = true;
                  const fieldValue = (entry as Record<string, unknown>)[field];
                  bloatBytes += JSON.stringify(fieldValue).length;
                }
              }
            }
          }

          if (!hasBloat || bloatBytes < bloatThresholdBytes) {
            lastCleanupMs = now;
            return;
          }

          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours: 24,
            nowMs: now,
          });
          sidecarWriter(cleaned, sessionsPath);
          lastCleanupMs = now;
          api.logger?.info?.(
            `[oc-compaction-helper] agent_end cleanup: ` +
              `${report.strippedFieldCount} fields stripped, ` +
              `${report.reductionPercent}% size reduction`
          );
        } catch (err) {
          api.logger?.error?.(
            `[oc-compaction-helper] agent_end cleanup failed: ${String(err)}`
          );
        }
      }
    );

    // ── Hook: after_compaction — strip bloat fields ──────────
    // Fires after compaction completes. This is a deep cleanup that
    // also purges stale subagent entries.
    api.on(
      "after_compaction",
      async () => {
        try {
          const raw = reader(sessionsPath);
          if (!raw) return;
          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours: 24,
            nowMs: Date.now(),
          });
          sidecarWriter(cleaned, sessionsPath);
          lastCleanupMs = Date.now();
          api.logger?.info?.(
            `[oc-compaction-helper] after_compaction cleanup: ` +
              `${report.strippedFieldCount} fields stripped, ` +
              `${report.reductionPercent}% size reduction`
          );
        } catch (err) {
          api.logger?.error?.(
            `[oc-compaction-helper] after_compaction failed: ${String(err)}`
          );
        }
      }
    );

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
              content: [
                {
                  type: "text" as const,
                  text: "sessions.json not found — no transcript data available.",
                },
              ],
            };
          }
          const sizeBytes = JSON.stringify(raw).length;
          const sizeMb = Math.round(sizeBytes / (1024 * 1024) * 100) / 100;
          const entryCount = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) =>
            k.includes("subagent")
          ).length;

          // Count bloat fields
          let bloatFieldCount = 0;
          let bloatBytes = 0;
          for (const entry of Object.values(raw)) {
            if (typeof entry === "object" && entry !== null) {
              for (const field of bloatFields) {
                if (field in entry) {
                  bloatFieldCount++;
                  bloatBytes += JSON.stringify(
                    (entry as Record<string, unknown>)[field]
                  ).length;
                }
              }
            }
          }

          const needsCompaction = sizeMb >= maxTranscriptMb;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    sizeMb,
                    sizeBytes,
                    entryCount,
                    subagentCount,
                    bloatFieldCount,
                    bloatBytes,
                    bloatPercent:
                      sizeBytes > 0
                        ? Math.round((bloatBytes / sizeBytes) * 100)
                        : 0,
                    thresholdMb: maxTranscriptMb,
                    needsCompaction,
                    lastCleanupMs,
                    throttleMs,
                    recommendation: needsCompaction
                      ? `Transcript is ${sizeMb} MB (threshold: ${maxTranscriptMb} MB). ` +
                        "Consider triggering compaction to reduce bloat."
                      : `Transcript is ${sizeMb} MB (threshold: ${maxTranscriptMb} MB). ` +
                        "No compaction needed at this time.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: "text" as const, text: `compact_check failed: ${String(err)}` },
            ],
          };
        }
      },
    });
  },
});
