/**
 * OcMemoryRecall — pure logic seam.
 *
 * @behavior
 * Pure decision logic for the oc-memory-recall plugin (Deliverables 0, 1, 2):
 * - Note frontmatter parsing & schema verification (Deliverable 0)
 * - In-memory registry & path/kind indexing (Deliverable 0)
 * - Fire / hit / follow telemetry state transitions (Deliverable 1)
 * - M6 marker-on-file-read signpost generation (Deliverable 2)
 *
 * @invariants
 * - Every function is pure: same input → same output, zero side effects.
 * - No imports of I/O modules (node:fs, node:http, fetch).
 * - No Date.now() / Math.random() — timestamps are injected if needed.
 * - Zero auxiliary model calls: all decisions are deterministic host compute.
 *
 * @dft
 * - Tested in memory-recall-logic.spec.ts with inline data, zero fixtures.
 */

export const RECOGNIZED_NOTE_KINDS = [
  "house_style",
  "authority",
  "silent_trap",
  "code_rule",
  "domain_fact",
  "external_dep",
  "procedure",
  "user_preference",
  "environment",
  "project_status",
  "architectural_decision",
  "historical_incident",
  "workaround",
  "glossary",
] as const;

export type NoteKind = (typeof RECOGNIZED_NOTE_KINDS)[number] | (string & {});

export interface MemoryNoteFrontmatter {
  kind: NoteKind;
  use_when: string;
  does_not_apply_when: string;
  provenance: string;
  source: string;
  title?: string;
  paths?: string[];
  bind?: string;
  predicate?: string;
  event?: string;
  updated?: string;
  [key: string]: unknown;
}

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

/** Pre-compiled static regexes for v2 grammar & linting (no hot-loop re-compilation) */
export const PREDICATE_INTERNAL_PERIOD_REGEX = /\.[ \t]+[A-Za-z]/;
export const IMPERATIVE_MOOD_REGEX = /^(do not|never|always|ensure|make sure|use|avoid|please)\b/i;
export const PATH_SHAPE_REGEX = /^(\.?\.?\/|[\w-]+\/|[a-zA-Z]:\\|[\w-]+\.[a-zA-Z0-9]+$)[\w\-./\\]*$/;
export const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

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

export interface MemoryNote {
  id: string;
  frontmatter: MemoryNoteFrontmatter;
  content: string;
  raw: string;
  valid: boolean;
  errors?: string[];
}

export interface NoteRegistry {
  notes: Map<string, MemoryNote>;
  pathToNotes: Map<string, MemoryNote[]>;
  kindToNotes: Map<string, MemoryNote[]>;
}

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

export const DEFAULT_MARKER_PREFIX =
  "# [SIGNPOST] May be out of date; the current version is kept in memory:";

// ── 1. Frontmatter Parsing (Pure) ──────────────────────────────────────────

/**
 * Cheap frontmatter gate: true only when the raw content starts with a
 * closed `---` frontmatter block that contains a `kind:` key.
 *
 * Episodic session logs carry `date:`-style frontmatter (or none at all) and
 * must never reach the parser — this predicate is the boot-flood guard that
 * keeps registry loading O(authoritative notes), not O(all markdown).
 */
export function hasKindFrontmatter(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return false;
  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return false;
  const block = rest.slice(0, endIdx);
  return /^kind\s*:/m.test(block);
}

/**
 * Parses markdown note content containing YAML frontmatter.
 * Requires: kind, use_when, does_not_apply_when, provenance, source.
 */
export function parseNoteFrontmatter(
  rawContent: string,
  noteId = "unknown",
): MemoryNote {
  const errors: string[] = [];
  const trimmed = rawContent.trimStart();

  if (!trimmed.startsWith("---")) {
    return {
      id: noteId,
      frontmatter: {
        kind: "unknown",
        use_when: "",
        does_not_apply_when: "",
        provenance: "",
        source: "",
      },
      content: rawContent,
      raw: rawContent,
      valid: false,
      errors: ["Missing frontmatter header ('---')"],
    };
  }

  const endMatch = trimmed.slice(3).indexOf("\n---");
  if (endMatch === -1) {
    return {
      id: noteId,
      frontmatter: {
        kind: "unknown",
        use_when: "",
        does_not_apply_when: "",
        provenance: "",
        source: "",
      },
      content: rawContent,
      raw: rawContent,
      valid: false,
      errors: ["Unclosed frontmatter block (missing terminating '---')"],
    };
  }

  const yamlBlock = trimmed.slice(3, 3 + endMatch).trim();
  const bodyContent = trimmed.slice(3 + endMatch + 4).trim();
  const parsed = parseSimpleYaml(yamlBlock);

  // Validate the 5 foundation schema fields
  const requiredFields: Array<keyof MemoryNoteFrontmatter> = [
    "kind",
    "use_when",
    "does_not_apply_when",
    "provenance",
    "source",
  ];

  for (const field of requiredFields) {
    const val = parsed[field];
    if (typeof val !== "string" || val.trim().length === 0) {
      errors.push(`Missing or empty required frontmatter field '${field}'`);
    }
  }

  const frontmatter: MemoryNoteFrontmatter = {
    kind: String(parsed.kind ?? "unknown"),
    use_when: String(parsed.use_when ?? ""),
    does_not_apply_when: String(parsed.does_not_apply_when ?? ""),
    provenance: String(parsed.provenance ?? ""),
    source: String(parsed.source ?? ""),
    title: typeof parsed.title === "string" ? parsed.title : undefined,
    bind: typeof parsed.bind === "string" ? parsed.bind : undefined,
    predicate: typeof parsed.predicate === "string" ? parsed.predicate : undefined,
    event: typeof parsed.event === "string" ? parsed.event : undefined,
    updated: parsed.updated !== undefined && parsed.updated !== null ? String(parsed.updated).trim() : undefined,
    paths: Array.isArray(parsed.paths)
      ? (parsed.paths as string[]).map((p) => String(p).trim())
      : undefined,
    ...parsed,
  };

  return {
    id: noteId,
    frontmatter,
    content: bodyContent,
    raw: rawContent,
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/** Lightweight, deterministic YAML key-value / list parser for frontmatter. */
function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split("\n");

  let currentListKey: string | null = null;
  let currentList: string[] = [];

  for (let rawLine of lines) {
    // Strip YAML comments outside of quotes
    let inDouble = false;
    let inSingle = false;
    let line = rawLine;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === "#" && !inDouble && !inSingle) {
        if (i === 0 || /\s/.test(rawLine[i - 1])) {
          line = rawLine.slice(0, i);
          break;
        }
      }
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && currentListKey) {
      const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      currentList.push(item);
      continue;
    }

    if (currentListKey) {
      result[currentListKey] = currentList;
      currentListKey = null;
      currentList = [];
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();

    if (!rawVal) {
      // Possible start of a list
      currentListKey = key;
      currentList = [];
      continue;
    }

    // Inline scalar string / number / boolean
    let val: unknown = rawVal.replace(/^["']|["']$/g, "");
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (!isNaN(Number(val)) && rawVal !== "") val = Number(val);

    result[key] = val;
  }

  if (currentListKey) {
    result[currentListKey] = currentList;
  }

  return result;
}

// ── 2. Note Registry Indexing (Pure) ──────────────────────────────────────

export function normalizePath(pathStr: string): string {
  let normalized = pathStr.replace(/\\/g, "/").trim();
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function createRegistry(notes: MemoryNote[]): NoteRegistry {
  const noteMap = new Map<string, MemoryNote>();
  const pathToNotes = new Map<string, MemoryNote[]>();
  const kindToNotes = new Map<string, MemoryNote[]>();

  for (const note of notes) {
    // Registry holds authoritative notes only. Parse-failure notes (missing
    // frontmatter, unclosed blocks, missing required fields) must never be
    // indexed — they would flood kind tables with `unknown` entries.
    if (!note.valid) continue;

    noteMap.set(note.id, note);

    // Index by kind
    const kind = note.frontmatter.kind;
    const existingKind = kindToNotes.get(kind) ?? [];
    existingKind.push(note);
    kindToNotes.set(kind, existingKind);

    // Index by target paths
    const rawTargetPaths: string[] = [];
    if (note.frontmatter.source) {
      rawTargetPaths.push(note.frontmatter.source);
    }
    if (Array.isArray(note.frontmatter.paths)) {
      rawTargetPaths.push(...note.frontmatter.paths);
    }

    const uniqueNormPaths = new Set(rawTargetPaths.map((p) => normalizePath(p)));
    for (const norm of uniqueNormPaths) {
      const existingPath = pathToNotes.get(norm) ?? [];
      existingPath.push(note);
      pathToNotes.set(norm, existingPath);
    }
  }

  return { notes: noteMap, pathToNotes, kindToNotes };
}

export function findNotesForPath(
  registry: NoteRegistry,
  targetPath: string,
): MemoryNote[] {
  const norm = normalizePath(targetPath);
  const direct = registry.pathToNotes.get(norm);
  if (direct && direct.length > 0) return direct;

  // Suffix/filename match (e.g. target is "/abs/path/to/foo.md" and note indexed "foo.md")
  const results: MemoryNote[] = [];
  for (const [indexedPath, notes] of registry.pathToNotes.entries()) {
    if (norm.endsWith(indexedPath) || indexedPath.endsWith(norm)) {
      for (const n of notes) {
        if (!results.includes(n)) {
          results.push(n);
        }
      }
    }
  }

  return results;
}

export function findNotesForKind(
  registry: NoteRegistry,
  kind: string,
): MemoryNote[] {
  return registry.kindToNotes.get(kind) ?? [];
}

// ── 3. Telemetry State & Transitions (Pure) ───────────────────────────────

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

// ── 4. Marker-on-File-Read (Deliverable 2 - M6) ───────────────────────────

// ── 4. Cue Grammar & Three-Slot Projection (Schema v2) ─────────────────────

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
  const headingMatch = content.match(/^#+\s+(.+)$/m);
  if (headingMatch && headingMatch[1].trim().length > 0) {
    return headingMatch[1].trim();
  }
  return note.id.replace(/\.md$/, "");
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
  const pointer = note.frontmatter.source || note.id;
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
  prefix = DEFAULT_MARKER_PREFIX,
  context: CueContext = { arm: "file_read" },
): string {
  // If note carries v2 fields, project using v2 grammar
  if (note.frontmatter.predicate || note.frontmatter.bind || note.frontmatter.event) {
    const cue = projectCueLine(note, context);
    if (!cue.emitted) return "";
    return `${prefix} ${cue.cueText}`;
  }

  // Backwards-compatible v1 fallback
  const pointer = note.frontmatter.source || note.id;
  const useWhen = note.frontmatter.use_when ? ` (${note.frontmatter.use_when})` : "";
  return `${prefix} ${pointer}${useWhen}`;
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
  markerPrefix = DEFAULT_MARKER_PREFIX,
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

// ── 5. Status & Verification (Pure) ───────────────────────────────────────

export function isProsePointer(pathStr: string): boolean {
  const trimmed = pathStr.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return true;
  }
  if (trimmed.includes(" ") && !trimmed.includes("/") && !trimmed.includes("\\")) {
    return true;
  }
  if (trimmed.split(/\s+/).length > 2) {
    return true;
  }
  if (!trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes(".")) {
    return true;
  }
  return false;
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

// ── 6. Tool-Description Note Injection (Deliverable 5 - M2) ────────────────

export interface ToolDescriptionInjectionResult {
  tools: Array<{ name: string; description?: string; [key: string]: unknown }>;
  modifiedCount: number;
  notesApplied: MemoryNote[];
}

export function formatToolNoteSignpost(note: MemoryNote): string {
  const pointer = note.frontmatter.source || note.id;
  const useWhen = note.frontmatter.use_when ? ` — ${note.frontmatter.use_when}` : "";
  return `\n[Memory Authority: ${pointer} (${note.frontmatter.kind})${useWhen}]`;
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
      const pointer = n.frontmatter.source || n.id;
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

// ── 7. Note Catalogue (Deliverable 6 - M7) ──────────────────────────────────

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
    const pointer = n.frontmatter.source || n.id;
    const title = n.frontmatter.title ? ` "${n.frontmatter.title}"` : "";
    lines.push(`• [${n.frontmatter.kind}]${title} (${pointer}) — use when: ${n.frontmatter.use_when}`);
  }

  return {
    catalogue: lines.join("\n"),
    totalListed: selected.length,
    totalAvailable,
  };
}

// ── 8. Pre-Reply Review Gate Linter (Deliverable 6 - M4) ────────────────────

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
          const pointer = note.frontmatter.source || note.id;
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

// ── 9. Resume Refresh (Deliverable 6 - M5) ──────────────────────────────────

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
      const pointer = n.frontmatter.source || n.id;
      lines.push(`• [${n.frontmatter.kind}] ${pointer} — ${n.frontmatter.use_when}`);
    }
  }

  return {
    summary: lines.join("\n"),
    refreshedNotes: selected,
  };
}
