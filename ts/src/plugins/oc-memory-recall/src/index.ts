/**
 * OcMemoryRecall — plugin entry point (wiring layer).
 *
 * @behavior
 * Wires the note registry and M6 marker-on-file-read signposts to OpenClaw.
 * - gateway_start: indexes memory notes from notesDir into in-memory registry.
 * - tool_result_persist: intercepts file-read tools and prepends signposts.
 * - recall_status: reports registry size, kinds, and fire/hit/follow telemetry.
 * - recall_verify: validates note frontmatter schemas.
 *
 * @invariants
 * - No logic here — wiring only (load → pure seam → update state).
 * - No direct node:fs imports — I/O goes through injectable MemoryNotesLoader.
 * - Zero auxiliary model calls: 100% deterministic local compute.
 *
 * @dft
 * - Tested via integration tests with an in-memory double.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import {
  DEFAULT_MARKER_PREFIX,
  buildRecallStatusReport,
  createInitialTelemetry,
  createRegistry,
  hasKindFrontmatter,
  parseNoteFrontmatter,
  processToolResultForFileRead,
  recordFire,
  recordHit,
  verifyNotes,
  buildNoteCatalogue,
  lintAgentReply,
  applyReplyLintCorrection,
  buildResumeRefreshNotice,
  injectToolDescriptionNotes,
  type MemoryNote,
  type NoteRegistry,
  type RecallTelemetryState,
} from "./memory-recall-logic.js";
import {
  readNotesFromDisk,
  type MemoryNotesLoader,
  type RawNoteFile,
} from "./memory-recall-io.js";
import {
  createInitialSessionHoldState,
  evaluateEventPush,
  cleanExpiredSessionHolds,
  type SessionHoldState,
  type DeliveryPolicy,
} from "./event-push-logic.js";

export interface OcMemoryRecallConfig {
  /** Directory containing memory note markdown files (default: "memory"). */
  notesDir?: string;
  /** Explicitly enumerated subdirectories of notesDir to scan (flat, non-recursive). Episodic logs elsewhere are never indexed. */
  subdirs?: string[];
  /** Custom signpost prefix string for M6 file-read markers. */
  markerPrefix?: string;
  /** Whether telemetry tracking is active (default: true). */
  telemetryEnabled?: boolean;
  /** Optional injectable loader for testing (DFT Axiom 5). */
  notesLoader?: MemoryNotesLoader;
  /** Whether M1 user-channel event push is active (default: true). */
  eventPushEnabled?: boolean;
  /** Default delivery policy for event push ("hold-once" | "let-run", default: "hold-once"). */
  defaultPolicy?: DeliveryPolicy;
  /** Safety ceiling TTL in milliseconds for hold-once records (default: 30 minutes). */
  holdOnceTtlMs?: number;
}

export default definePluginEntry({
  id: "oc-memory-recall",
  name: "OcMemoryRecall",
  description:
    "Memory-recall delivery arms — note registry, telemetry, and M6 marker-on-file-read signposts",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as OcMemoryRecallConfig) ?? {};
    const notesDir = cfg.notesDir ?? "memory";
    const subdirs = Array.isArray(cfg.subdirs) ? cfg.subdirs.map(String) : [];
    const markerPrefix = cfg.markerPrefix ?? DEFAULT_MARKER_PREFIX;
    const notesLoader: MemoryNotesLoader = cfg.notesLoader ?? readNotesFromDisk;
    const eventPushEnabled = cfg.eventPushEnabled ?? true;
    const defaultPolicy: DeliveryPolicy = cfg.defaultPolicy ?? "hold-once";
    const holdOnceTtlMs = cfg.holdOnceTtlMs ?? 1_800_000;

    let registry: NoteRegistry = createRegistry([]);
    let telemetry: RecallTelemetryState = createInitialTelemetry();
    let sessionHolds: SessionHoldState = createInitialSessionHoldState();
    // Last boot-scan accounting. Skipped files (no kind frontmatter) are kept
    // raw so recall_verify can still diagnose them on demand — the registry
    // itself never holds them.
    let lastScan: { scanned: number; candidates: number; skipped: RawNoteFile[] } = {
      scanned: 0,
      candidates: 0,
      skipped: [],
    };

    function reloadRegistry(): { registry: NoteRegistry; scanned: number; candidates: number } {
      const rawNotes = notesLoader(notesDir, subdirs);
      // Boot-flood guard: only files whose frontmatter block carries a `kind:`
      // key reach the parser. Episodic session logs are skipped at O(1) each
      // and never enter the registry (see hasKindFrontmatter).
      const candidates = rawNotes.filter((n) => hasKindFrontmatter(n.rawContent));
      const parsedNotes: MemoryNote[] = candidates.map((n) =>
        parseNoteFrontmatter(n.rawContent, n.id),
      );
      registry = createRegistry(parsedNotes);
      const candidateIds = new Set(candidates.map((n) => n.id));
      lastScan = {
        scanned: rawNotes.length,
        candidates: candidates.length,
        skipped: rawNotes.filter((n) => !candidateIds.has(n.id)),
      };
      return { registry, scanned: rawNotes.length, candidates: candidates.length };
    }

    // ── Hook: gateway_start ──────────────────────────────────────────
    api.on("gateway_start", async () => {
      try {
        const { registry: reg, scanned, candidates } = reloadRegistry();
        const validCount = Array.from(reg.notes.values()).filter((n) => n.valid).length;
        api.logger?.info?.(
          `[oc-memory-recall] scanned ${scanned} md files, ${candidates} kind-frontmatter candidates, indexed ${reg.notes.size} notes (${validCount} valid) across ${reg.kindToNotes.size} kinds`,
        );

        // ── Resume Refresh (Deliverable 6 - M5) ────────────────────────
        const refresh = buildResumeRefreshNotice(reg);
        if (refresh.summary) {
          for (const note of refresh.refreshedNotes) {
            telemetry = recordFire(telemetry, note.frontmatter.kind, "M5");
            telemetry = recordHit(telemetry, note.frontmatter.kind, "M5");
          }
          if (typeof api.session?.workflow?.enqueueNextTurnInjection === "function") {
            await api.session.workflow.enqueueNextTurnInjection({
              text: refresh.summary,
              idempotencyKey: `m5-refresh-${reg.notes.size}`,
            });
          } else if (typeof api.enqueueNextTurnInjection === "function") {
            await api.enqueueNextTurnInjection({
              text: refresh.summary,
              idempotencyKey: `m5-refresh-${reg.notes.size}`,
            });
          }
        }
      } catch (err) {
        api.logger?.error?.(
          `[oc-memory-recall] gateway_start failed: ${String(err)}`,
        );
      }
    });

    // ── Hook: tool_result_persist ────────────────────────────────────
    api.on("tool_result_persist", (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      try {
        const msg = (event.message as Record<string, unknown>) ?? {};
        const toolName = String(event.toolName ?? ctx?.toolName ?? "");
        const params = (event.params as Record<string, unknown>) ?? (ctx?.params as Record<string, unknown>) ?? {};

        // Extract content to modify
        let originalContent = "";
        let isStringContent = true;

        if (typeof msg.content === "string") {
          originalContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          isStringContent = false;
          const textBlock = (msg.content as Array<Record<string, unknown>>).find((b) => b.type === "text");
          if (textBlock && typeof textBlock.text === "string") {
            originalContent = textBlock.text;
          }
        }

        if (!originalContent) {
          return undefined;
        }

        const res = processToolResultForFileRead(
          toolName,
          params,
          originalContent,
          registry,
          markerPrefix,
        );

        if (!res.modified) {
          return undefined;
        }

        // Record M6 telemetry for each matching note
        for (const note of res.notesApplied) {
          telemetry = recordHit(telemetry, note.frontmatter.kind, "M6");
          telemetry = recordFire(telemetry, note.frontmatter.kind, "M6");
        }

        // Return updated message
        if (isStringContent) {
          return { message: { ...msg, content: res.output } };
        } else {
          const newContent = (msg.content as Array<Record<string, unknown>>).map((b) => {
            if (b.type === "text") {
              return { ...b, text: res.output };
            }
            return b;
          });
          return { message: { ...msg, content: newContent } };
        }
      } catch (err) {
        api.logger?.warn?.(
          `[oc-memory-recall] tool_result_persist error: ${String(err)}`,
        );
        return undefined;
      }
    });

    // ── Hook: after_tool_call (Deliverable 4 - M1) ───────────────────
    api.on("after_tool_call", async (event: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      try {
        if (!eventPushEnabled) return;

        const nowMs = Date.now();
        const toolName = String(event.toolName ?? ctx?.toolName ?? "");
        const sessionKey = String(ctx?.sessionKey ?? event.sessionKey ?? "default-session");
        const params = (event.params as Record<string, unknown>) ?? {};
        const result = event.result;
        const error = typeof event.error === "string" ? event.error : undefined;

        // Clean expired holds opportunistically
        sessionHolds = cleanExpiredSessionHolds(sessionHolds, nowMs, holdOnceTtlMs);

        const decision = evaluateEventPush(
          registry,
          {
            toolName,
            params,
            result,
            error,
            sessionKey,
          },
          sessionHolds,
          nowMs,
          {
            defaultPolicy,
            holdOnceTtlMs,
          },
        );

        sessionHolds = decision.newHoldState;

        if (!decision.shouldPush) return;

        for (const item of decision.notesToPush) {
          if (typeof api.session?.workflow?.enqueueNextTurnInjection === "function") {
            await api.session.workflow.enqueueNextTurnInjection({
              sessionKey,
              text: item.cueText,
              idempotencyKey: item.idempotencyKey,
            });
          } else if (typeof api.enqueueNextTurnInjection === "function") {
            await api.enqueueNextTurnInjection({
              sessionKey,
              text: item.cueText,
              idempotencyKey: item.idempotencyKey,
            });
          }

          // Record M1 telemetry: fired and hit into subsequent turn context
          telemetry = recordFire(telemetry, item.note.frontmatter.kind, "M1");
          telemetry = recordHit(telemetry, item.note.frontmatter.kind, "M1");

          api.logger?.info?.(
            `[oc-memory-recall] M1 event push enqueued for ${item.note.id} ` +
              `into session ${sessionKey} (policy: ${item.policy})`,
          );
        }
      } catch (err) {
        api.logger?.warn?.(
          `[oc-memory-recall] after_tool_call event push error: ${String(err)}`,
        );
      }
    });

    // ── Hook: before_agent_reply (Deliverable 6 - M4 Linter) ─────────
    api.on("before_agent_reply", async (event: Record<string, unknown>) => {
      try {
        const cleanedBody = typeof event.cleanedBody === "string" ? event.cleanedBody : "";
        if (!cleanedBody) return undefined;

        const lint = lintAgentReply(cleanedBody, registry);
        if (lint.valid) return undefined;

        // Record M4 telemetry for flagged notes
        for (const item of lint.missingSignposts) {
          telemetry = recordFire(telemetry, item.kind, "M4");
          telemetry = recordHit(telemetry, item.kind, "M4");
        }

        const corrected = applyReplyLintCorrection(cleanedBody, lint);
        return {
          handled: true,
          reply: { text: corrected, body: corrected },
        };
      } catch (err) {
        api.logger?.warn?.(
          `[oc-memory-recall] before_agent_reply lint error: ${String(err)}`,
        );
        return undefined;
      }
    });

    // ── Tool: recall_status ──────────────────────────────────────────
    api.registerTool({
      name: "recall_status",
      description:
        "Memory-recall registry and telemetry snapshot — notes indexed, kind breakdown, and fire/hit/follow metrics.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const report = buildRecallStatusReport(registry, telemetry);
          const scanLine = `scan: ${lastScan.scanned} md files seen, ${lastScan.skipped.length} skipped (no kind frontmatter), ${lastScan.candidates} candidates`;
          return {
            content: [{ type: "text" as const, text: `${report.verdict}: ${report.summary}\n${scanLine}` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `failed: ${String(err)}` }],
          };
        }
      },
    });

    // ── Tool: recall_verify ──────────────────────────────────────────
    api.registerTool({
      name: "recall_verify",
      description:
        "Validate memory note frontmatter schemas and resolve watched file paths.",
      parameters: Type.Object({
        reload: Type.Optional(Type.Boolean({
          description: "If true, reloads notes from disk before verifying (default: true)",
        })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reload = params.reload !== false;
          if (reload) {
            reloadRegistry();
          }
          // Delivery registry (valid notes only) + on-demand diagnostics for
          // gate-skipped files, so malformed note files still surface here.
          const skippedParsed = lastScan.skipped.map((f) =>
            parseNoteFrontmatter(f.rawContent, f.id),
          );
          const notes = [...Array.from(registry.notes.values()), ...skippedParsed];
          const verification = verifyNotes(notes);
          const verdict = verification.invalidCount > 0 ? "failed" : "ok";
          const summary = `verified ${notes.length} notes: ${verification.validCount} valid, ${verification.invalidCount} invalid`;
          const details = verification.issues.length > 0
            ? `\nissues:\n${verification.issues.map((i) => `  - ${i.id}: ${i.errors.join(", ")}`).join("\n")}`
            : "";
          return {
            content: [{ type: "text" as const, text: `${verdict}: ${summary}${details}` }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `failed: ${String(err)}` }],
          };
        }
      },
    });

    // ── Tool: recall_catalogue (Deliverable 6 - M7) ──────────────────
    api.registerTool({
      name: "recall_catalogue",
      description:
        "Browse memory note catalogue — 1-line index of notes, kinds, live pointers, and scope conditions.",
      parameters: Type.Object({
        kind: Type.Optional(Type.String({ description: "Filter catalogue by note kind" })),
        maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 50)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const kinds = typeof params.kind === "string" ? [params.kind] : undefined;
          const maxEntries = typeof params.maxEntries === "number" ? params.maxEntries : undefined;
          const report = buildNoteCatalogue(registry, { kinds, maxEntries });
          return {
            content: [{ type: "text" as const, text: report.catalogue }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `failed: ${String(err)}` }],
          };
        }
      },
    });
  },
});
