/**
 * Reply Linter & Review Gate Logic — pre-reply verification, catalogue, and telemetry.
 *
 * @dft principle: Unit decomposition under separation of concerns.
 * Zero inline regexes, zero else-if chains, pure deterministic execution.
 */

import type { MemoryNote } from "./note-schema-logic.ts";
import type { NoteRegistry } from "./note-registry-logic.ts";
import {
  resolvePointer,
  projectCueLine,
  isProsePointer,
  EVENT_SLOT_KINDS,
} from "./cue-projection-logic.ts";
import {
  PREDICATE_INTERNAL_PERIOD_REGEX,
  IMPERATIVE_MOOD_REGEX,
  ISO_8601_REGEX,
} from "./recall-regex-utils.ts";

export interface ArmTelemetry {
  fired: number;
  hit: number;
  followed: number;
}

export interface RecallTelemetryState {
  stats: Record<string, Record<string, ArmTelemetry>>;
  totalFired: number;
  totalHit: number;
  totalFollowed: number;
}

export function createInitialTelemetry(): RecallTelemetryState {
  return {
    stats: {},
    totalFired: 0,
    totalHit: 0,
    totalFollowed: 0,
  };
}

function getOrInitArm(
  state: RecallTelemetryState,
  kind: string,
  arm: string,
): ArmTelemetry {
  const kindStats = state.stats[kind] ?? {};
  return kindStats[arm] ?? { fired: 0, hit: 0, followed: 0 };
}

export function recordFire(
  state: RecallTelemetryState,
  kind: string,
  arm: string,
): RecallTelemetryState {
  const current = getOrInitArm(state, kind, arm);
  const updated: ArmTelemetry = { ...current, fired: current.fired + 1 };
  const nextKind = { ...(state.stats[kind] ?? {}), [arm]: updated };
  return {
    ...state,
    stats: { ...state.stats, [kind]: nextKind },
    totalFired: state.totalFired + 1,
  };
}

export function recordHit(
  state: RecallTelemetryState,
  kind: string,
  arm: string,
): RecallTelemetryState {
  const current = getOrInitArm(state, kind, arm);
  const updated: ArmTelemetry = { ...current, hit: current.hit + 1 };
  const nextKind = { ...(state.stats[kind] ?? {}), [arm]: updated };
  return {
    ...state,
    stats: { ...state.stats, [kind]: nextKind },
    totalHit: state.totalHit + 1,
  };
}

export function recordFollow(
  state: RecallTelemetryState,
  kind: string,
  arm: string,
): RecallTelemetryState {
  const current = getOrInitArm(state, kind, arm);
  const updated: ArmTelemetry = { ...current, followed: current.followed + 1 };
  const nextKind = { ...(state.stats[kind] ?? {}), [arm]: updated };
  return {
    ...state,
    stats: { ...state.stats, [kind]: nextKind },
    totalFollowed: state.totalFollowed + 1,
  };
}

export function formatTelemetryReport(state: RecallTelemetryState): string {
  const kinds = Object.keys(state.stats);
  if (kinds.length === 0) {
    return "telemetry: 0 events logged (fired: 0, hit: 0, followed: 0)";
  }

  const lines: string[] = [
    `telemetry: totals (fired: ${state.totalFired}, hit: ${state.totalHit}, followed: ${state.totalFollowed})`,
  ];

  for (const kind of kinds) {
    const arms = state.stats[kind];
    for (const [arm, counts] of Object.entries(arms)) {
      lines.push(
        `  • [${kind}][${arm}]: fired=${counts.fired} hit=${counts.hit} followed=${counts.followed}`,
      );
    }
  }

  return lines.join("\n");
}

export function lintNoteSchemaV2(note: MemoryNote): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Path pointers: Tightened contract: exact readable paths only; prose/URIs rejected
  if (Array.isArray(note.frontmatter.paths)) {
    for (const p of note.frontmatter.paths) {
      if (isProsePointer(String(p))) {
        errors.push(`Path entry '${p}' does not look like a filesystem path (prose/URI pointer)`);
      }
    }
  }

  // 2. Predicate field: single clause, <= 140 chars, no internal periods, no imperative mood
  if (typeof note.frontmatter.predicate === "string") {
    const pred = note.frontmatter.predicate.trim();
    if (pred.length > 140) {
      errors.push(`Predicate exceeds 140 characters (${pred.length} chars)`);
    }
    if (PREDICATE_INTERNAL_PERIOD_REGEX.test(pred)) {
      errors.push("Predicate must be a single clause (contains sentence-internal period)");
    }
    const impMatch = pred.match(IMPERATIVE_MOOD_REGEX);
    if (impMatch) {
      errors.push(`Predicate must not use imperative mood ('${impMatch[0]}')`);
    }
  }

  // 3. Updated field: must be valid ISO 8601
  if (typeof note.frontmatter.updated === "string" && note.frontmatter.updated.trim().length > 0) {
    const rawUpdated = note.frontmatter.updated.trim();
    if (!ISO_8601_REGEX.test(rawUpdated) || isNaN(Date.parse(rawUpdated))) {
      warnings.push(`Field 'updated' is not a valid ISO 8601 date string ('${rawUpdated}')`);
    }
  }

  // 4. Event field: warning if present on non-event kind
  if (typeof note.frontmatter.event === "string" && note.frontmatter.event.trim().length > 0) {
    const kind = String(note.frontmatter.kind ?? "").toLowerCase();
    if (!EVENT_SLOT_KINDS.has(kind) && kind !== "open_loop" && kind !== "case") {
      warnings.push(`Field 'event' present on non-event kind '${note.frontmatter.kind}'`);
    }
  }

  return { errors, warnings };
}

export interface NoteVerificationResult {
  validCount: number;
  invalidCount: number;
  issues: Array<{ id: string; errors: string[] }>;
  warnings: Array<{ id: string; warnings: string[] }>;
}

export function verifyNotes(notes: MemoryNote[]): NoteVerificationResult {
  let validCount = 0;
  let invalidCount = 0;
  const issues: Array<{ id: string; errors: string[] }> = [];
  const warnings: Array<{ id: string; warnings: string[] }> = [];

  for (const n of notes) {
    const v2Lint = lintNoteSchemaV2(n);
    const combinedErrors = [...(n.errors ?? []), ...v2Lint.errors];

    if (combinedErrors.length === 0) {
      validCount++;
    } else {
      invalidCount++;
      issues.push({ id: n.id, errors: combinedErrors });
    }

    if (v2Lint.warnings.length > 0) {
      warnings.push({ id: n.id, warnings: v2Lint.warnings });
    }
  }

  return { validCount, invalidCount, issues, warnings };
}

export function buildRecallStatusReport(
  registry: NoteRegistry,
  telemetry: RecallTelemetryState,
): {
  verdict: "ok" | "warning";
  summary: string;
  detail: Record<string, unknown>;
} {
  const noteList = Array.from(registry.notes.values());
  const { validCount, invalidCount, issues } = verifyNotes(noteList);
  const kinds = Array.from(registry.kindToNotes.keys());
  const totalTrackedPaths = registry.pathToNotes.size;

  const verdict = invalidCount > 0 ? "warning" : "ok";
  const summaryLines: string[] = [
    `notes: ${noteList.length} total (${validCount} valid, ${invalidCount} invalid), ${kinds.length} kinds, ${totalTrackedPaths} tracked paths`,
    formatTelemetryReport(telemetry),
  ];

  if (invalidCount > 0) {
    summaryLines.push(
      `issues (${invalidCount}): ${issues.map((i) => `${i.id}: [${i.errors.join(", ")}]`).join("; ")}`,
    );
  }

  return {
    verdict,
    summary: summaryLines.join("\n"),
    detail: {
      totalNotes: noteList.length,
      validCount,
      invalidCount,
      kinds,
      trackedPaths: totalTrackedPaths,
      telemetry: telemetry.stats,
      issues,
    },
  };
}

export interface ToolDescriptionInjectionResult {
  tools: Array<{ name: string; description?: string; [key: string]: unknown }>;
  modifiedCount: number;
  notesApplied: MemoryNote[];
}

export function formatToolNoteSignpost(note: MemoryNote): string {
  const { pointer, context } = resolvePointer(note);
  const contextSuffix = context ? ` — via: ${context}` : "";
  const useWhen = note.frontmatter.use_when ? ` — ${note.frontmatter.use_when}` : "";
  return `\n[Memory Authority: ${pointer} (${note.frontmatter.kind})${contextSuffix}${useWhen}]`;
}

export function injectToolDescriptionNotes(
  tools: Array<{ name: string; description?: string; [key: string]: unknown }>,
  registry: NoteRegistry
): ToolDescriptionInjectionResult {
  const notesApplied: MemoryNote[] = [];
  let modifiedCount = 0;

  const updatedTools = tools.map((tool) => {
    const matchingNotes: MemoryNote[] = [];
    const tName = tool.name.toLowerCase();

    for (const note of registry.notes.values()) {
      if (!note.valid) continue;

      let matches = false;
      if (Array.isArray(note.frontmatter.tools)) {
        if ((note.frontmatter.tools as string[]).some((t) => String(t).toLowerCase() === tName)) {
          matches = true;
        }
      }
      if (typeof note.frontmatter.tool === "string" && note.frontmatter.tool.toLowerCase() === tName) {
        matches = true;
      }
      if (
        (note.frontmatter.kind === "authority" || note.frontmatter.kind === "procedure") &&
        note.frontmatter.use_when.toLowerCase().includes(tName)
      ) {
        matches = true;
      }

      if (matches && !matchingNotes.includes(note)) {
        matchingNotes.push(note);
      }
    }

    if (matchingNotes.length === 0) {
      return tool;
    }

    let desc = tool.description ?? "";
    let toolModified = false;

    for (const n of matchingNotes) {
      const signpost = formatToolNoteSignpost(n);
      const { pointer } = resolvePointer(n);
      if (!desc.includes(pointer)) {
        desc += signpost;
        toolModified = true;
        if (!notesApplied.includes(n)) {
          notesApplied.push(n);
        }
      }
    }

    if (toolModified) {
      modifiedCount++;
      return { ...tool, description: desc };
    }
    return tool;
  });

  return { tools: updatedTools, modifiedCount, notesApplied };
}

export interface CatalogueOptions {
  maxEntries?: number;
  kinds?: string[];
}

export interface CatalogueReport {
  catalogue: string;
  totalListed: number;
  totalAvailable: number;
}

export function buildNoteCatalogue(
  registry: NoteRegistry,
  options?: CatalogueOptions
): CatalogueReport {
  const allNotes = Array.from(registry.notes.values()).filter((n) => n.valid);
  const totalAvailable = allNotes.length;

  const filterKinds = options?.kinds ? new Set(options.kinds.map((k) => k.toLowerCase())) : null;
  const filtered = filterKinds
    ? allNotes.filter((n) => filterKinds.has(String(n.frontmatter.kind).toLowerCase()))
    : allNotes;

  const maxEntries = options?.maxEntries ?? 50;
  const selected = filtered.slice(0, maxEntries);

  if (selected.length === 0) {
    return {
      catalogue: "# [MEMORY CATALOGUE] No active memory notes available.",
      totalListed: 0,
      totalAvailable,
    };
  }

  const lines: string[] = [
    `# [MEMORY CATALOGUE] ${selected.length} of ${totalAvailable} memory notes:`,
  ];

  for (const n of selected) {
    const { pointer, context } = resolvePointer(n);
    const contextSuffix = context ? ` — via: ${context}` : "";
    const title = n.frontmatter.title ? ` "${n.frontmatter.title}"` : "";
    lines.push(`• [${n.frontmatter.kind}]${title} (${pointer}${contextSuffix}) — use when: ${n.frontmatter.use_when}`);
  }

  return {
    catalogue: lines.join("\n"),
    totalListed: selected.length,
    totalAvailable,
  };
}

export interface MissingSignpost {
  noteId: string;
  kind: string;
  pointer: string;
  referencedPath: string;
  reason: string;
}

export interface ReplyLintReport {
  valid: boolean;
  missingSignposts: MissingSignpost[];
  suggestedAdditions: string[];
}

export function lintAgentReply(
  replyBody: string,
  registry: NoteRegistry
): ReplyLintReport {
  const missingSignposts: MissingSignpost[] = [];
  const seenNoteIds = new Set<string>();
  const lowerBody = replyBody.toLowerCase();

  for (const [indexedPath, notes] of registry.pathToNotes.entries()) {
    if (!indexedPath || indexedPath.length < 3) continue;

    if (lowerBody.includes(indexedPath.toLowerCase())) {
      for (const note of notes) {
        if (!note.valid || seenNoteIds.has(note.id)) continue;
        if (
          note.frontmatter.kind === "authority" ||
          note.frontmatter.kind === "code_rule" ||
          note.frontmatter.kind === "silent_trap" ||
          note.frontmatter.kind === "architectural_decision"
        ) {
          const { pointer } = resolvePointer(note);
          const noteTitle = note.frontmatter.title?.toLowerCase();
          const hasCitation =
            (note.id !== indexedPath && lowerBody.includes(note.id.toLowerCase())) ||
            (Boolean(noteTitle) && lowerBody.includes(noteTitle!)) ||
            lowerBody.includes("[signpost]") ||
            lowerBody.includes("[memory") ||
            lowerBody.includes("authority note") ||
            lowerBody.includes("per note");

          if (!hasCitation) {
            seenNoteIds.add(note.id);
            missingSignposts.push({
              noteId: note.id,
              kind: String(note.frontmatter.kind),
              pointer,
              referencedPath: indexedPath,
              reason: `Referenced path '${indexedPath}' has required ${note.frontmatter.kind} signpost`,
            });
          }
        }
      }
    }
  }

  const suggestedAdditions = missingSignposts.map(
    (m) => `[Memory Notice: Path '${m.referencedPath}' governed by ${m.kind}: ${m.pointer}]`
  );

  return {
    valid: missingSignposts.length === 0,
    missingSignposts,
    suggestedAdditions,
  };
}

export function applyReplyLintCorrection(
  replyBody: string,
  report: ReplyLintReport
): string {
  if (report.valid || report.suggestedAdditions.length === 0) {
    return replyBody;
  }
  return `${replyBody.trim()}\n\n---\n${report.suggestedAdditions.join("\n")}`;
}

export interface ResumeRefreshResult {
  summary: string;
  refreshedNotes: MemoryNote[];
}

export function buildResumeRefreshNotice(
  registry: NoteRegistry,
  options?: { maxNotes?: number }
): ResumeRefreshResult {
  const maxNotes = options?.maxNotes ?? 5;
  const priorityKinds = new Set(["authority", "architectural_decision", "project_status"]);
  const candidates: MemoryNote[] = [];

  for (const note of registry.notes.values()) {
    if (note.valid && priorityKinds.has(String(note.frontmatter.kind))) {
      candidates.push(note);
    }
  }

  const selected = candidates.slice(0, maxNotes);
  if (selected.length === 0) {
    return {
      summary: "",
      refreshedNotes: [],
    };
  }

  const lines: string[] = [
    `# [MEMORY RESUME REFRESH] Standing authority & decisions in memory:`,
  ];

  for (const n of selected) {
    if (n.frontmatter.predicate || n.frontmatter.bind || n.frontmatter.event) {
      const cue = projectCueLine(n, { arm: "resume_refresh" });
      lines.push(`• [${n.frontmatter.kind}] ${cue.cueText}`);
    } else {
      const { pointer, context } = resolvePointer(n);
      const contextSuffix = context ? ` — via: ${context}` : "";
      lines.push(`• [${n.frontmatter.kind}] ${pointer}${contextSuffix} — ${n.frontmatter.use_when}`);
    }
  }

  return {
    summary: lines.join("\n"),
    refreshedNotes: selected,
  };
}
