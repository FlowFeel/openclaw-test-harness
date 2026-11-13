/**
 * Resume Delta I/O — file stat reader for M8 resume delta tracking.
 *
 * @behavior
 * Reads file modification timestamps (mtimeMs) for specified paths or directories.
 * Exported as an injectable function so tests can supply mock file state.
 *
 * @invariants
 * - Safe against missing files/directories (never throws, returns empty/partial record).
 * - Only performs read-only filesystem stats.
 *
 * @dft
 * - Standalone injectable function.
 * - Tested with real and mock filesystem inputs.
 */

import { statSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

export type PathMtimeReader = (paths?: string[]) => Record<string, number>;

export function readPathMtimes(paths?: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  if (!paths || paths.length === 0) return result;

  for (const rawPath of paths) {
    if (!rawPath) continue;
    const absPath = resolve(rawPath);
    if (!existsSync(absPath)) continue;

    try {
      const st = statSync(absPath);
      if (st.isDirectory()) {
        const entries = readdirSync(absPath);
        for (const entry of entries) {
          if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
          const fullEntryPath = join(absPath, entry);
          try {
            const entryStat = statSync(fullEntryPath);
            if (entryStat.isFile()) {
              result[fullEntryPath] = Math.floor(entryStat.mtimeMs);
            }
          } catch {
            // Ignore unreadable entries
          }
        }
      }
      if (st.isFile()) {
        result[absPath] = Math.floor(st.mtimeMs);
      }
    } catch {
      // Ignore unreadable paths
    }
  }

  return result;
}
