/**
 * Sessions I/O — file system access for sessions.json.
 *
 * @behavior
 * Reads and writes sessions.json. The reader/writer are exported as
 * functions with injectable paths, making them testable with mock
 * file systems.
 *
 * @dft
 * - Functions are standalone (testable in isolation)
 * - Path is injectable
 * - Returns null on missing file (not an error)
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionsMap } from "../../shared/session-cleanup.js";

const DEFAULT_PATH = resolve(
  process.env.HOME || "/home/node",
  ".openclaw/agents/main/sessions/sessions.json"
);

export type SessionsReader = (path?: string) => SessionsMap | null;
export type SessionsWriter = (data: SessionsMap, path?: string) => void;

export function readSessions(path?: string): SessionsMap | null {
  const p = path ?? DEFAULT_PATH;
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    return JSON.parse(raw) as SessionsMap;
  } catch {
    return null;
  }
}

export function writeSessions(data: SessionsMap, path?: string): void {
  const p = path ?? DEFAULT_PATH;
  writeFileSync(p, JSON.stringify(data, null, 0));
}

/**
 * Get the file size of sessions.json in bytes.
 * Returns 0 if the file doesn't exist or can't be stat'd.
 * Used as a free payload-size estimate for sidecar offload decisions
 * (avoids JSON.stringify on the main thread — one syscall vs N serializations).
 */
export function getSessionFileSize(path?: string): number {
  const p = path ?? DEFAULT_PATH;
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Write a pre-serialized string to sessions.json.
 * Used by the sidecar-aware writer when the sidecar returns a serialized
 * string — writes it directly without re-serializing on the main thread.
 */
export function writeSessionsString(content: string, path?: string): void {
  const p = path ?? DEFAULT_PATH;
  writeFileSync(p, content);
}