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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
