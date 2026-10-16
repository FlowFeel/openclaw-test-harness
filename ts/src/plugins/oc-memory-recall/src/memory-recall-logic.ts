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
  [key: string]: unknown;
}

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

  for (let line of lines) {
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx);
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
    noteMap.set(note.id, note);

    // Index by kind
    const kind = note.frontmatter.kind;
    const existingKind = kindToNotes.get(kind) ?? [];
    existingKind.push(note);
    kindToNotes.set(kind, existingKind);

    // Index by target paths
    const targetPaths: string[] = [];
    if (note.frontmatter.source) {
      targetPaths.push(note.frontmatter.source);
    }
    if (Array.isArray(note.frontmatter.paths)) {
      targetPaths.push(...note.frontmatter.paths);
    }

    for (const p of targetPaths) {
      const norm = normalizePath(p);
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

export function formatFileMarker(
  note: MemoryNote,
  prefix = DEFAULT_MARKER_PREFIX,
): string {
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

  const signpostLines = matchingNotes.map((note) =>
    formatFileMarker(note, markerPrefix),
  );
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

export function verifyNotes(notes: MemoryNote[]): {
  validCount: number;
  invalidCount: number;
  issues: Array<{ id: string; errors: string[] }>;
} {
  let validCount = 0;
  let invalidCount = 0;
  const issues: Array<{ id: string; errors: string[] }> = [];

  for (const n of notes) {
    if (n.valid) {
      validCount++;
    } else {
      invalidCount++;
      issues.push({ id: n.id, errors: n.errors ?? ["Unknown validation error"] });
    }
  }

  return { validCount, invalidCount, issues };
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
