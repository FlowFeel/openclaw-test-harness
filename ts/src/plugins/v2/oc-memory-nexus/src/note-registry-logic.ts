/**
 * Note Registry Logic — in-memory indexing and lookup by path and kind.
 *
 * @dft principle: Unit decomposition under separation of concerns.
 */

import type { MemoryNote } from "./note-schema-logic.ts";
import { backslashGlobal } from "./recall-regex-utils.ts";

export interface NoteRegistry {
  notes: Map<string, MemoryNote>;
  pathToNotes: Map<string, MemoryNote[]>;
  kindToNotes: Map<string, MemoryNote[]>;
}

export function normalizePath(pathStr: string): string {
  let normalized = pathStr.replace(backslashGlobal(), "/").trim();
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
