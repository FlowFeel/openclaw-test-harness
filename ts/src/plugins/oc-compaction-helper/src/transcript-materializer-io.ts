/**
 * Transcript Materializer I/O — atomic compaction successor materialization.
 *
 * Closes the "Unmaterialized Compaction Rotation Trap" (T-581): a compaction
 * entry exists in the transcript, but the turn died before
 * `updateSessionStoreAfterAgentRun` rotated the physical .jsonl, leaving the
 * session pegged at the context ceiling as a zombie.
 *
 * @behavior
 * - Reads sessions.json (flat map keyed by sessionKey) and candidate .jsonl
 *   transcripts; runs pure detection; materializes the successor transcript
 *   (header + compaction entry + kept lines) as a NEW file; patches
 *   sessions.json to point at it.
 * - Race guard: never touches sessions that are actively running. A session
 *   is safe to materialize when its status is not "running", OR its status is
 *   "running" but `updatedAt` is older than stalenessMs (a turn cannot legally
 *   outlive ~600s, so stale-running is a zombie, not an active turn).
 * - Telemetry: caller-logged result with line counts and bytes saved.
 *
 * @dft
 * - All I/O confined to this seam; logic lives in transcript-materializer-logic.ts (pure)
 * - Paths injectable / derivable from explicit arguments (testable with mock dirs)
 * - Successor file is additive: the original .jsonl is never modified or deleted,
 *   so materialization is reversible without a separate backup
 * - sessions.json patch is crash-safe: backup -> tmp -> rename
 * - Missing files return null results, not thrown errors
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import {
  readSessions,
  getSessionFileSize,
} from "./sessions-io.js";
import {
  detectUnrotatedCompaction,
  buildSuccessorLines,
  estimateContextTokens,
  type DetectOptions,
} from "./transcript-materializer-logic.js";

export interface MaterializeOptions {
  sessionsPath?: string;
  /** Fallback dir used when sessionFile is missing/relative. */
  sessionsDir?: string;
  /** Guard: treat "running" as a zombie after this many ms of updatedAt staleness. Default: 900000 (15m). */
  stalenessMs?: number;
  minLinesBeforeKept?: number;
  /** Injected clock for deterministic tests. Default: Date.now(). */
  nowMs?: number;
  /** Injected uuid generator for deterministic tests. Default: randomUUID(). */
  newSessionId?: string;
}

export interface MaterializeResult {
  materialized: boolean;
  sessionKey: string;
  oldLines?: number;
  newLines?: number;
  savedBytes?: number;
  newSessionFile?: string;
  newSessionId?: string;
  reason?: string;
}

/** Statuses that are safe to materialize immediately (no active turn can exist). */
const SAFE_STATUSES = new Set(["idle", "killed", "timeout", "aborted"]);

function isStale(updatedAt: unknown, stalenessMs: number, nowMs: number): boolean {
  if (typeof updatedAt !== "string" && typeof updatedAt !== "number") return false;
  const t = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number(updatedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t >= stalenessMs;
}

/** Race guard per review: skip active turns; stale "running" is a zombie, not a turn. */
export function isMaterializationSafe(
  entry: Record<string, unknown>,
  stalenessMs: number,
  nowMs: number,
): boolean {
  const status = typeof entry.status === "string" ? entry.status : "";
  if (SAFE_STATUSES.has(status)) return true;
  if (status === "running") return isStale(entry.updatedAt, stalenessMs, nowMs);
  // Unknown status: only proceed when clearly stale.
  return isStale(entry.updatedAt, stalenessMs, nowMs);
}

/**
 * ISO timestamp formatted per the existing sessions-dir filename convention:
 * 2026-08-21T21-29-40-926Z (colons and dots replaced by dashes).
 */
export function formatTimestampForFilename(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Materialize the compaction successor for a single session.
 * Returns a MaterializeResult; `materialized: false` with a reason when the
 * session is healthy, actively running, has no unrotated compaction, or the
 * files are unreadable. Never throws on missing data.
 */
export function materializeSuccessorForSession(
  sessionKey: string,
  opts?: MaterializeOptions,
): MaterializeResult {
  const fail = (reason: string): MaterializeResult => ({
    materialized: false,
    sessionKey,
    reason,
  });

  const sessionsPath = opts?.sessionsPath;
  const sessions = readSessions(sessionsPath);
  if (!sessions) return fail("sessions.json unreadable or missing");
  const entry = sessions[sessionKey];
  if (!entry || typeof entry !== "object") return fail("session entry not found");

  const sessionFile =
    typeof (entry as { sessionFile?: unknown }).sessionFile === "string"
      ? (entry as { sessionFile: string }).sessionFile
      : null;
  if (!sessionFile) return fail("entry has no sessionFile");
  const transcriptPath = resolve(sessionFile);
  if (!existsSync(transcriptPath)) return fail("transcript file missing on disk");

  const nowMs = opts?.nowMs ?? Date.now();
  const stalenessMs = opts?.stalenessMs ?? 900_000;
  if (!isMaterializationSafe(entry as Record<string, unknown>, stalenessMs, nowMs)) {
    return fail("session actively running (race guard)");
  }

  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return fail("transcript unreadable");
  }
  // Drop trailing empty lines from the final newline so line counts are exact.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const detectOpts = opts?.minLinesBeforeKept
    ? { minLinesBeforeKept: opts.minLinesBeforeKept }
    : undefined;
  const detection = detectUnrotatedCompaction(lines, detectOpts);
  if (!detection.unrotated) {
    return fail(`no unrotated compaction (${detection.reason ?? "not detected"})`);
  }

  const newSessionId = opts?.newSessionId ?? randomUUID();
  const timestampIso = new Date(nowMs).toISOString();
  const built = buildSuccessorLines(lines, detection, {
    newSessionId,
    timestamp: timestampIso,
  });

  const dir = opts?.sessionsDir ?? dirname(transcriptPath);
  const newSessionFile = resolve(
    dir,
    `${formatTimestampForFilename(timestampIso)}_${newSessionId}.jsonl`,
  );

  // Write successor: tmp -> rename (original file intentionally untouched).
  try {
    const tmp = `${newSessionFile}.tmp`;
    writeFileSync(tmp, built.lines.join("\n") + "\n", "utf8");
    renameSync(tmp, newSessionFile);
  } catch {
    return fail("failed to write successor transcript");
  }

  // Patch sessions.json: backup -> tmp -> rename.
  const oldBytes = statSync(transcriptPath).size;
  const newBytes = Buffer.byteLength(built.lines.join("\n") + "\n", "utf8");
  const patched = { ...sessions };
  patched[sessionKey] = {
    ...(entry as Record<string, unknown>),
    sessionFile: newSessionFile,
    sessionId: newSessionId,
    status: "idle",
    contextTokens: estimateContextTokens(built.lines),
    updatedAt: timestampIso,
  };
  const targetPath = sessionsPath
    ? resolve(sessionsPath)
    : resolve(
        process.env.HOME || "/home/node",
        ".openclaw/agents/main/sessions/sessions.json",
      );
  try {
    if (existsSync(targetPath)) {
      copyFileSync(targetPath, `${targetPath}.bak`);
    }
    const tmp = `${targetPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(patched, null, 0), "utf8");
    renameSync(tmp, targetPath);
  } catch {
    // Roll back: remove the orphan successor so state stays consistent.
    try {
      if (existsSync(newSessionFile)) {
        unlinkSync(newSessionFile);
      }
    } catch {
      /* best-effort cleanup */
    }
    return fail("failed to patch sessions.json (successor removed)");
  }

  return {
    materialized: true,
    sessionKey,
    oldLines: lines.length,
    newLines: built.lines.length,
    savedBytes: Math.max(0, oldBytes - newBytes),
    newSessionFile,
    newSessionId,
  };
}

export interface SweepOptions extends Omit<MaterializeOptions, "newSessionId"> {
  /** Max materializations per sweep to bound work. Default: 3. */
  maxMaterializations?: number;
}

/**
 * Sweep every session entry in sessions.json for the unrotated-compaction
 * zombie state and materialize successors (bounded by maxMaterializations).
 * Cheap pre-filter first: only candidates get their .jsonl read.
 */
export function sweepUnrotatedSessions(
  opts?: SweepOptions,
): { swept: number; results: MaterializeResult[] } {
  const sessionsPath = opts?.sessionsPath;
  const sessions = readSessions(sessionsPath);
  if (!sessions) return { swept: 0, results: [] };

  const nowMs = opts?.nowMs ?? Date.now();
  const stalenessMs = opts?.stalenessMs ?? 900_000;
  const cap = opts?.maxMaterializations ?? 3;

  const candidates = Object.keys(sessions).filter((key) => {
    const entry = sessions[key];
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.sessionFile !== "string") return false;
    // Cheap pre-filter: file size >= 2MB OR context ceiling signals a candidate.
    let big = false;
    try {
      big = statSync(resolve(e.sessionFile as string)).size >= 2_000_000;
    } catch {
      return false;
    }
    if (!big) return false;
    return isMaterializationSafe(e, stalenessMs, nowMs);
  });

  const results: MaterializeResult[] = [];
  for (const key of candidates) {
    if (results.length >= cap) break;
    results.push(
      materializeSuccessorForSession(key, { ...opts, nowMs, stalenessMs }),
    );
  }
  return { swept: candidates.length, results };
}
