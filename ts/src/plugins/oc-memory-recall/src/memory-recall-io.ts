/**
 * OcMemoryRecall — I/O Protocol wrapper.
 *
 * @behavior
 * Declares Protocol types for filesystem I/O (reading note markdown files).
 * The plugin accepts these as injectable functions, so tests inject
 * in-memory doubles without touching the real disk (DFT Axiom 5).
 *
 * @invariants
 * - Protocol interfaces are declared here, not in logic files.
 * - Logic files depend only on pure data structures.
 * - No logic here — only I/O wiring.
 *
 * @dft
 * - Tested via integration tests with an in-memory double.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEADING_SLASH_REGEX,
  backslashGlobal,
  edgeSlashes,
} from "../../shared/regex-library.ts";

export interface RawNoteFile {
  id: string;
  rawContent: string;
  filePath: string;
}

export interface MemoryNotesLoader {
  (notesDir: string, subdirs?: string[]): RawNoteFile[];
}

/**
 * Scans `notesDir` (flat, non-recursive) plus each explicitly enumerated
 * subdirectory in `subdirs` (also flat). Files are returned regardless of
 * content; callers gate on frontmatter before parsing (see
 * `hasKindFrontmatter` in memory-recall-logic.ts).
 *
 * `id` is the path relative to `notesDir` so same-named files across
 * subdirectories cannot collide in the registry.
 */
export function readNotesFromDisk(notesDir: string, subdirs: string[] = []): RawNoteFile[] {
  if (!existsSync(notesDir)) {
    return [];
  }

  const results: RawNoteFile[] = [];

  function scan(dir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      try {
        if (entry.endsWith(".md")) {
          const rawContent = readFileSync(fullPath, "utf8");
          // id is notesDir-relative and POSIX-normalized so registry keys are stable
          const relId = fullPath
            .slice(notesDir.length)
            .replace(LEADING_SLASH_REGEX as RegExp, "")
            .replace(backslashGlobal(), "/");
          results.push({
            id: relId.length > 0 ? relId : entry,
            rawContent,
            filePath: fullPath,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  scan(notesDir);
  for (const sub of subdirs) {
    // Flat scan of each explicitly enumerated subdirectory — never recursive,
    // so an unexpected tree cannot flood the boot scan.
    const clean = String(sub ?? "").replace(edgeSlashes(), "");
    if (clean.length === 0 || clean.includes("..") || clean.includes("/")) continue;
    scan(join(notesDir, clean));
  }
  return results;
}
