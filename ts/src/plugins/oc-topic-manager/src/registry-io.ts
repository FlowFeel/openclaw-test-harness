/**
 * registry-io — filesystem access for topic recovery.
 *
 * @behavior
 * Thin shells over the pure apply-recovery logic and the shared sessions-io
 * reader/writer. Reads the OC registry, applies a plan, persists the result.
 *
 * @dft
 * - All decision logic is in apply-recovery.ts (pure) — this file only moves
 *   bytes.
 * - Path is injectable (defaults to the shared sessions.json default) so the
 *   container can point at a fixture registry.
 */

import { readSessions, writeSessions } from "../../shared/sessions-io.ts";
import { statSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  applyRecoveryPlan,
  registrationsFromSessions,
} from "./apply-recovery.ts";
import type {
  RecoveryApplication,
  RecoveryPlan,
  SessionRegistration,
} from "./types.ts";
import type { SessionsMap } from "../../shared/session-cleanup.ts";

/** Milliseconds → ISO-8601. */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Read topic registrations from the OC session registry. */
export function readRegistrations(path?: string): SessionRegistration[] {
  const sessions = readSessions(path);
  if (sessions === null) return [];
  return registrationsFromSessions(sessions);
}

/** Read the full registry (null when the file is missing). */
export function readRegistry(path?: string): SessionsMap | null {
  return readSessions(path);
}

/**
 * Resolve transcript file sizes for session entries in the registry.
 * Inspects `entry.sessionFile` if present, falling back to `{dir}/{sessionId}.jsonl`.
 */
export function readTranscriptSizes(
  sessions: SessionsMap,
  sessionsPath?: string
): Record<string, number> {
  const sizes: Record<string, number> = {};
  const baseDir = sessionsPath ? dirname(sessionsPath) : undefined;

  for (const [key, entry] of Object.entries(sessions)) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { sessionFile?: unknown; sessionId?: unknown };
    let filePath: string | undefined;

    if (typeof rec.sessionFile === "string" && rec.sessionFile) {
      filePath = rec.sessionFile;
    } else if (typeof rec.sessionId === "string" && rec.sessionId && baseDir) {
      filePath = resolve(baseDir, `${rec.sessionId}.jsonl`);
    }

    if (filePath && existsSync(filePath)) {
      try {
        const st = statSync(filePath);
        sizes[key] = st.size;
      } catch {
        // Ignore unreadable files defensively
      }
    }
  }

  return sizes;
}

/**
 * Apply a recovery plan to the registry on disk and persist it.
 * Returns the A6 report from the pure layer.
 */
export function writeRecoveryPlan(
  plan: RecoveryPlan,
  path?: string
): RecoveryApplication {
  const sessions = readSessions(path) ?? {};
  const nowMs = Date.now();
  const { updated, report } = applyRecoveryPlan(plan, sessions, nowMs);
  if (report.applied) {
    const entry = updated[plan.sessionKey];
    if (entry && typeof entry.registeredAtMs === "number") {
      entry.registeredAt = toIso(entry.registeredAtMs);
    }
    writeSessions(updated, path);
  }
  return report;
}
