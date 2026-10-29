/**
 * Transcript I/O seam for finding and rewriting session JSONL files safely.
 *
 * @behavior
 * - Resolves session JSONL file path from sessionKey or sessionId.
 * - Reads transcript lines from disk.
 * - Writes sanitized lines using crash-safe atomic write (backup -> tmp -> rename).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { readSessions } from "./sessions-io.js";

export type TranscriptReader = (path: string) => string[] | null;
export type TranscriptWriter = (path: string, lines: string[]) => void;
export type SessionPathResolver = (sessionKeyOrId: string, baseDir?: string) => string | null;

export function getDefaultSessionsDir(): string {
  return resolve(
    process.env.HOME || "/home/node",
    ".openclaw/agents/main/sessions"
  );
}

/**
 * Resolves .jsonl transcript file path from sessionKey or sessionId.
 */
export function resolveSessionTranscriptPath(
  sessionKeyOrId: string,
  baseDir?: string,
): string | null {
  const dir = baseDir ?? getDefaultSessionsDir();

  // 1. Direct UUID or filename check
  if (sessionKeyOrId.endsWith(".jsonl")) {
    const directPath = resolve(dir, sessionKeyOrId);
    if (existsSync(directPath)) return directPath;
  }

  const directUuidPath = resolve(dir, `${sessionKeyOrId}.jsonl`);
  if (existsSync(directUuidPath)) {
    return directUuidPath;
  }

  // 2. Lookup in sessions.json
  const sessionsJsonPath = resolve(dir, "sessions.json");
  const sessions = readSessions(sessionsJsonPath);
  if (sessions) {
    // Check direct key
    const entry = sessions[sessionKeyOrId];
    if (entry && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string") {
      const p = resolve(dir, `${(entry as { sessionId: string }).sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }

    // Search values by sessionKey / sessionId
    for (const [key, val] of Object.entries(sessions)) {
      if (key === sessionKeyOrId) {
        if (typeof (val as { sessionId?: unknown }).sessionId === "string") {
          const p = resolve(dir, `${(val as { sessionId: string }).sessionId}.jsonl`);
          if (existsSync(p)) return p;
        }
      }
      if (typeof val === "object" && val !== null) {
        const sid = (val as { sessionId?: unknown }).sessionId;
        if (sid === sessionKeyOrId) {
          const p = resolve(dir, `${sid}.jsonl`);
          if (existsSync(p)) return p;
        }
      }
    }
  }

  return null;
}

export function readTranscriptLines(path: string): string[] | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return raw.split("\n");
  } catch {
    return null;
  }
}

export function writeTranscriptLines(path: string, lines: string[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = lines.join("\n") + "\n";

  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
