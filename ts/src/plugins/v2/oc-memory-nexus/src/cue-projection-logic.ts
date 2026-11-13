/**
 * Cue Projection Logic — pure grammar projection, three-slot compression, and signposts.
 *
 * @dft principle: Unit decomposition under separation of concerns.
 * All regexes live in recall-regex-utils.ts; messages in recall-messages.ts.
 */

import type { MemoryNote } from "./note-schema-logic.ts";
import { findNotesForPath, type NoteRegistry } from "./note-registry-logic.ts";
import {
  PREDICATE_INTERNAL_PERIOD_REGEX,
  MARKDOWN_HEADING_REGEX,
  MD_EXTENSION_REGEX,
  WHITESPACE_SEQUENCE_REGEX,
} from "./recall-regex-utils.ts";
import { RECALL_MESSAGES } from "./recall-messages.ts";

export type CompressionLevel = "skip" | "plain" | "three_slot" | "event_slot";

export interface CueContext {
  arm: "file_read" | "event_push" | "tool_notes" | "resume_refresh" | "status";
  targetPath?: string;
  fileMtimeMs?: number;
  nowMs?: number;
}

export interface CueProjectionResult {
  cueText: string;
  emitted: boolean;
  compression: CompressionLevel;
  reason?: string;
}

export const SKIP_LIST_KINDS = new Set<string>([
  "procedure",
  "workaround",
  "historical_incident",
]);

export const EVENT_SLOT_KINDS = new Set<string>([
  "open_loop",
  "case",
  "case_study",
]);

export const DEFAULT_MARKER_PREFIX = RECALL_MESSAGES.SIGNPOST_PREFIX;

/**
 * Extracts the BIND anchor for the note.
 * Precedence: note.frontmatter.bind -> note.frontmatter.title -> first markdown heading in content -> note.id
 */
export function extractBindPhrase(note: MemoryNote, rawContent?: string): string {
  if (typeof note.frontmatter.bind === "string" && note.frontmatter.bind.trim().length > 0) {
    return note.frontmatter.bind.trim();
  }
  if (typeof note.frontmatter.title === "string" && note.frontmatter.title.trim().length > 0) {
    return note.frontmatter.title.trim();
  }
  const content = rawContent ?? note.content ?? "";
  const headingMatch = content.match(MARKDOWN_HEADING_REGEX);
  if (headingMatch && headingMatch[1].trim().length > 0) {
    return headingMatch[1].trim();
  }
  return note.id.replace(MD_EXTENSION_REGEX, "");
}

/**
 * Determines the compression level for a given note.
 */
export function getKindCompression(note: MemoryNote): CompressionLevel {
  const kind = String(note.frontmatter.kind ?? "").toLowerCase();
  if (SKIP_LIST_KINDS.has(kind)) {
    return "skip";
  }
  if (note.frontmatter.event || EVENT_SLOT_KINDS.has(kind)) {
    return "event_slot";
  }
  if (note.frontmatter.predicate) {
    return "three_slot";
  }
  return "plain";
}

/**
 * Condition gating: true when predicate claim is licensed by context.
 * File-read -> stale-in-view -> predicate permitted.
 * Injected / background context -> predicate suppressed (emit BIND+POINTER only).
 */
export function isPredicatePermitted(note: MemoryNote, context: CueContext): boolean {
  if (context.arm !== "file_read") {
    return false;
  }

  // If note has updated ISO timestamp and context provides fileMtimeMs
  if (note.frontmatter.updated && typeof context.fileMtimeMs === "number") {
    const updatedMs = Date.parse(String(note.frontmatter.updated));
    if (!isNaN(updatedMs) && updatedMs <= context.fileMtimeMs) {
      return false;
    }
  }

  return true;
}

/**
 * Pure projection function: cue(note, context) -> CueProjectionResult.
 * Implements fixed slot order:
 * - Claim: [PREDICATE]: [BIND] — see [POINTER]
 * - Event: [BIND], waiting for: [EVENT] — [PREDICATE]; see [POINTER]
 * - Plain: [BIND] — see [POINTER]
 * - Skip: suppressed
 */
export function projectCueLine(
  note: MemoryNote,
  context: CueContext = { arm: "file_read" },
): CueProjectionResult {
  const compression = getKindCompression(note);
  const { pointer } = resolvePointer(note);
  const bind = extractBindPhrase(note);

  // 1. Skip-list kinds (methods, mistakes)
  if (compression === "skip") {
    return {
      cueText: "",
      emitted: false,
      compression: "skip",
      reason: `Kind '${note.frontmatter.kind}' is on the skip-list (methods/mistakes)`,
    };
  }

  // 2. Event-slot (open loops, cases)
  if (compression === "event_slot" && note.frontmatter.event) {
    const event = String(note.frontmatter.event).trim();
    let predicate = note.frontmatter.predicate ? String(note.frontmatter.predicate).trim() : "";
    if (predicate && (predicate.length > 140 || PREDICATE_INTERNAL_PERIOD_REGEX.test(predicate))) {
      // Fallback: strip malformed predicate to preserve zero-crash safety
      predicate = "";
    }
    const cueText = predicate
      ? `${bind}, waiting for: ${event} — ${predicate}; see ${pointer}`
      : `${bind}, waiting for: ${event} — see ${pointer}`;
    return {
      cueText,
      emitted: true,
      compression: "event_slot",
    };
  }

  // 3. Three-slot (claim type)
  if (compression === "three_slot" && note.frontmatter.predicate) {
    const rawPred = String(note.frontmatter.predicate).trim();
    if (rawPred.length > 140 || PREDICATE_INTERNAL_PERIOD_REGEX.test(rawPred)) {
      return {
        cueText: `${bind} — see ${pointer}`,
        emitted: true,
        compression: "plain",
        reason: "Predicate violates single-clause or length boundaries; fallback to plain BIND + POINTER",
      };
    }

    if (isPredicatePermitted(note, context)) {
      const sep = rawPred.endsWith(":") ? " " : ": ";
      const cueText = `${rawPred}${sep}${bind} — see ${pointer}`;
      return {
        cueText,
        emitted: true,
        compression: "three_slot",
      };
    }
    // Condition gating suppressed predicate -> compress to plain BIND+POINTER
    return {
      cueText: `${bind} — see ${pointer}`,
      emitted: true,
      compression: "plain",
      reason: "Predicate suppressed by condition gating (no stale value in view)",
    };
  }

  // 4. Plain BIND+POINTER
  return {
    cueText: `${bind} — see ${pointer}`,
    emitted: true,
    compression: "plain",
  };
}

export function formatFileMarker(
  note: MemoryNote,
  prefix: string = DEFAULT_MARKER_PREFIX,
  context: CueContext = { arm: "file_read" },
): string {
  // If note carries v2 fields, project using v2 grammar
  if (note.frontmatter.predicate || note.frontmatter.bind || note.frontmatter.event) {
    const cue = projectCueLine(note, context);
    if (!cue.emitted) return "";
    return `${prefix} ${cue.cueText}`;
  }

  // Backwards-compatible v1 fallback
  const { pointer, context: pointerContext } = resolvePointer(note);
  const useWhen = note.frontmatter.use_when ? ` (${note.frontmatter.use_when})` : "";
  const contextSuffix = pointerContext ? ` (${pointerContext})` : "";
  return `${prefix} ${pointer}${contextSuffix}${useWhen}`;
}

export interface MarkerProcessResult {
  modified: boolean;
  output: string;
  notesApplied: MemoryNote[];
  pathMatched?: string;
}

export const FILE_READ_TOOLS = new Set([
  "read_file",
  "view_file",
  "readFile",
  "cat",
  "get_file",
]);

export function extractTargetFilePath(
  params: Record<string, unknown>,
): string | undefined {
  const candidates = [
    params.AbsolutePath,
    params.path,
    params.filePath,
    params.file,
    params.target,
    params.uri,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Pure processor for tool results on file reads.
 * Prepend signpost if the file has matching authoritative memory notes.
 */
export function processToolResultForFileRead(
  toolName: string,
  params: Record<string, unknown>,
  toolOutput: string,
  registry: NoteRegistry,
  markerPrefix: string = DEFAULT_MARKER_PREFIX,
): MarkerProcessResult {
  if (!FILE_READ_TOOLS.has(toolName)) {
    return { modified: false, output: toolOutput, notesApplied: [] };
  }

  const targetPath = extractTargetFilePath(params);
  if (!targetPath) {
    return { modified: false, output: toolOutput, notesApplied: [] };
  }

  const matchingNotes = findNotesForPath(registry, targetPath);
  if (matchingNotes.length === 0) {
    return { modified: false, output: toolOutput, notesApplied: [] };
  }

  const signpostLines = matchingNotes
    .map((note) =>
      formatFileMarker(note, markerPrefix, {
        arm: "file_read",
        targetPath,
      }),
    )
    .filter((line) => line.length > 0);

  if (signpostLines.length === 0) {
    return { modified: false, output: toolOutput, notesApplied: [] };
  }

  const signpostBlock = signpostLines.join("\n");
  const newOutput = `${signpostBlock}\n\n${toolOutput}`;

  return {
    modified: true,
    output: newOutput,
    notesApplied: matchingNotes,
    pathMatched: targetPath,
  };
}

export function isProsePointer(pathStr: string): boolean {
  const trimmed = pathStr.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return true;
  }
  if (trimmed.includes(" ") && !trimmed.includes("/") && !trimmed.includes("\\")) {
    return true;
  }
  if (trimmed.split(WHITESPACE_SEQUENCE_REGEX).length > 2) {
    return true;
  }
  if (!trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes(".")) {
    return true;
  }
  return false;
}

/**
 * Resolves the POINTER slot for any cue or signpost emission.
 */
export function resolvePointer(note: MemoryNote): {
  pointer: string;
  context?: string;
} {
  const source = note.frontmatter.source;
  const id = note.id.replace(MD_EXTENSION_REGEX, "");
  if (typeof source === "string" && source.trim().length > 0 && !isProsePointer(source)) {
    return { pointer: source.trim() };
  }
  const contextNote =
    typeof source === "string" && source.trim().length > 0 ? source.trim() : undefined;
  return { pointer: id, context: contextNote };
}
