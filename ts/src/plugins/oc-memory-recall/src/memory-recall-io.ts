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

export interface RawNoteFile {
  id: string;
  rawContent: string;
  filePath: string;
}

export interface MemoryNotesLoader {
  (notesDir: string): RawNoteFile[];
}

export function readNotesFromDisk(notesDir: string): RawNoteFile[] {
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
          results.push({
            id: entry,
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
  return results;
}
