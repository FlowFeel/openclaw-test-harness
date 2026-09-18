/**
 * registry-client — read topic registrations from the OC sessions.json.
 *
 * @behavior
 * I/O seam (impure by design): reads sessions.json (readable via an
 * injectable path, null on missing/unparseable — NO throws, mirroring
 * the oc-session-guard sessions-io pattern) and extracts topic
 * registrations from session keys of the canonical forum form:
 *
 *   agent:<agentId>:telegram:group:<chatId>:topic:<topicId>
 *
 * The key parser is exported as PURE `parseSessionKey` /
 * `extractTopicRegistrations` so the extraction logic is unit-testable
 * without touching the file system.
 *
 * @dft
 * - Path injectable; missing file → null, never an error.
 * - Parsing rules isolated in one function (parseSessionKey).
 * - Malformed keys are skipped, not thrown.
 *
 * @invariants
 * - Read-only: never writes sessions.json.
 * - Does not know about the molton API — telethon-client owns that.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionRegistration } from "./types.js";

const DEFAULT_PATH = resolve(
  process.env.HOME || "/home/node",
  ".openclaw/agents/main/sessions/sessions.json"
);

/** Canonical session-key shape for a Telegram forum topic. */
const TOPIC_KEY_PATTERN = /^agent:([A-Za-z0-9_.-]+):telegram:group:(-?\d+):topic:(\d+)$/;

export interface ParsedTopicKey {
  agentId: string;
  chatId: string;
  topicId: number;
  sessionKey: string;
}

/**
 * Parse a session key into its parts. Returns null for keys that are not
 * forum-topic sessions. Pure — no I/O, no throws.
 */
export function parseSessionKey(sessionKey: string): ParsedTopicKey | null {
  const m = TOPIC_KEY_PATTERN.exec(sessionKey);
  if (!m) return null;
  return {
    agentId: m[1],
    chatId: m[2],
    topicId: Number(m[3]),
    sessionKey,
  };
}

/**
 * Extract topic registrations from a sessions.json map (key → entry).
 * Ignores non-topic keys and keys that fail to parse. Pure.
 */
export function extractTopicRegistrations(
  sessions: Record<string, unknown>
): SessionRegistration[] {
  const out: SessionRegistration[] = [];
  for (const key of Object.keys(sessions)) {
    const parsed = parseSessionKey(key);
    if (parsed) out.push({ topicId: parsed.topicId, sessionKey: parsed.sessionKey });
  }
  return out;
}

/**
 * Read sessions.json and extract topic registrations.
 * Missing or unparseable files yield an empty list (never throws).
 */
export function readTopicRegistrations(path?: string): SessionRegistration[] {
  const p = path ?? DEFAULT_PATH;
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return [];
    return extractTopicRegistrations(parsed);
  } catch {
    return [];
  }
}