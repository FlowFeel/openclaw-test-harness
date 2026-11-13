/**
 * Note Schema Logic — pure frontmatter parsing, verification, and v2 grammar validation.
 *
 * @dft principle: Unit decomposition under separation of concerns.
 * Zero inline regexes, zero else-if chains, pure deterministic execution.
 */

import {
  KIND_LINE_REGEX,
  WHITESPACE_CHAR_REGEX,
  quoteTrimGlobal,
} from "./recall-regex-utils.ts";

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

export interface MemoryNote {
  id: string;
  frontmatter: MemoryNoteFrontmatter;
  content: string;
  raw: string;
  valid: boolean;
  errors?: string[];
}

/**
 * Cheap frontmatter gate: true only when the raw content starts with a
 * closed `---` frontmatter block that contains a `kind:` key.
 */
export function hasKindFrontmatter(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return false;
  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) return false;
  const block = rest.slice(0, endIdx);
  return KIND_LINE_REGEX.test(block);
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

// ═════════════════════════════════════════════════════════
// Per-kind default predicates (PR-1, bench crosswalk 2026-10-19)
// ═════════════════════════════════════════════════════════

/**
 * Per-kind default predicate seeds.
 *
 * Bench crosswalk (2026-10-19, Haiku 5.5 medium, one wording per idea)
 * measured cue predicates per state-change class: "value changed" U 0.96,
 * "the source of this figure was corrected" 0.95 (provenance-style per-note
 * override for domain_fact whose *source* changed), "approver changed" 0.93,
 * "owner's choice was revised" 0.72. A note carrying its own `predicate:`
 * frontmatter always wins; the seed only fills the gap so an un-predicated
 * note of a seeded kind projects three_slot instead of plain BIND+POINTER.
 *
 * Override via plugin config `kindPredicates`: entries merge over these
 * defaults per kind; an empty string disables the seed for that kind
 * (falls back to plain).
 */
export const DEFAULT_KIND_PREDICATES: Readonly<Record<string, string>> = Object.freeze({
  domain_fact: "value changed",
  authority: "approver changed",
  user_preference: "owner's choice was revised",
} as const);

export type KindPredicateTable = Readonly<Record<string, string>>;

/** Merges user config over the default seed table (pure). */
export function mergeKindPredicateTable(
  userConfig?: Record<string, string> | null,
  defaults: KindPredicateTable = DEFAULT_KIND_PREDICATES,
): KindPredicateTable {
  if (!userConfig || Object.keys(userConfig).length === 0) return defaults;
  return Object.freeze({ ...defaults, ...userConfig });
}

/**
 * Applies per-kind default predicates at load time (pure).
 * Only fills the gap: a note's own predicate, or a disabled/absent seed,
 * leaves the note untouched. Invalid notes are never modified.
 */
export function applyKindPredicateDefaults(
  note: MemoryNote,
  table: KindPredicateTable,
): MemoryNote {
  if (!note.valid) return note;
  const kind = String(note.frontmatter.kind ?? "").trim();
  const seed = table[kind];
  if (!seed || seed.trim().length === 0) return note;
  if (
    typeof note.frontmatter.predicate === "string" &&
    note.frontmatter.predicate.trim().length > 0
  ) {
    return note;
  }
  return { ...note, frontmatter: { ...note.frontmatter, predicate: seed.trim() } };
}

/** Lightweight, deterministic YAML key-value / list parser for frontmatter. */
export function parseSimpleYaml(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split("\n");

  let currentListKey: string | null = null;
  let currentList: string[] = [];

  for (const rawLine of lines) {
    // Strip YAML comments outside of quotes
    let inDouble = false;
    let inSingle = false;
    let line = rawLine;

    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      switch (ch) {
        case '"':
          if (!inSingle) inDouble = !inDouble;
          break;
        case "'":
          if (!inDouble) inSingle = !inSingle;
          break;
        case "#":
          if (!inDouble && !inSingle) {
            if (i === 0 || WHITESPACE_CHAR_REGEX.test(rawLine[i - 1])) {
              line = rawLine.slice(0, i);
              i = rawLine.length; // exit loop
            }
          }
          break;
        default:
          break;
      }
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && currentListKey) {
      const item = trimmed.slice(2).trim().replace(quoteTrimGlobal(), "");
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
    let val: unknown = rawVal.replace(quoteTrimGlobal(), "");
    switch (val) {
      case "true":
        val = true;
        break;
      case "false":
        val = false;
        break;
      default: {
        const num = Number(val);
        if (!isNaN(num) && rawVal !== "") {
          val = num;
        }
        break;
      }
    }

    result[key] = val;
  }

  if (currentListKey) {
    result[currentListKey] = currentList;
  }

  return result;
}
