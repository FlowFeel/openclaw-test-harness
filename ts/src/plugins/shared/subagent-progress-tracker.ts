/**
 * Subagent progress tracker — pure logic for intermediate progress heartbeats.
 *
 * @behavior
 * Extends the subagent-tracker's lifecycle tracking (spawn/end/stale) with
 * intermediate progress signals. A supervised subagent emits a heartbeat
 * `{status: "progress", pct: 0.5}` every 60s via the MessagePort. This module
 * records those heartbeats and detects subagents whose progress has gone
 * stale — distinguishing "stuck" (no heartbeat, likely crashed/hung) from
 * "on track" (recent heartbeat) from "stale heartbeat" (heartbeat present
 * but old).
 *
 * @why
 * The oc-subagent-watchdog (#35) detects terminal failures (crash, timeout).
 * But a subagent running for 2 minutes could be on track (50% done,
 * heartbeating every 60s) or stuck (hung on a bad web search, no heartbeat).
 * Without intermediate progress, the orchestrator can't tell until the run
 * timeout fires — wasting the timeout window. Progress heartbeats give early
 * warning and let the orchestrator make adaptive decisions (retry, reassign,
 * or wait).
 *
 * @invariants
 * - All functions are pure: input state → output state.
 * - Deterministic: no Date.now(), uses injected nowMs.
 * - State is immutable (each operation returns a new Map).
 * - detectStuck returns a StuckDetectionResult (the report, A6).
 * - Progress pct is clamped to [0, 1].
 *
 * @dft
 * - A1 (pure-io-separation): no imports, no I/O.
 * - A2 (determinism): injected timestamps.
 * - A6 (check-result): detectStuck returns a categorization report.
 */

// ── Constants ─────────────────────────────────────────────────

/** Default cap on heartbeat history retained for trend analysis. */
export const DEFAULT_HISTORY_CAP = 20;

/** Default expected heartbeat interval (matches the 60s heartbeat design). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────

/** A single progress heartbeat from a subagent. */
export interface ProgressHeartbeat {
  /** Completion fraction, 0..1. */
  pct: number;
  /** When the heartbeat arrived (injected timestamp). */
  ts: number;
}

/** The progress record for one subagent task. */
export interface ProgressRecord {
  taskId: string;
  startedAtMs: number;
  /** The most recent heartbeat, or undefined if none yet. */
  lastHeartbeat?: ProgressHeartbeat;
  /** Total heartbeats received. */
  heartbeatCount: number;
  /** Capped history of heartbeats for trend analysis. */
  history: ProgressHeartbeat[];
  /** Optional expected total duration, for interpolation when no heartbeat. */
  expectedDurationMs?: number;
}

export type ProgressMap = Map<string, ProgressRecord>;

/**
 * The stuck-detection result (A6 report).
 *
 * - `stuckTaskIds`: union of staleHeartbeat + noHeartbeat-past-grace — these
 *   need intervention (retry, reassign, or kill).
 * - `staleHeartbeatTaskIds`: had a heartbeat but it's older than maxAgeMs.
 * - `onTrackTaskIds`: recent heartbeat, progress advancing.
 * - `noHeartbeatTaskIds`: never heartbeated (may be within grace period).
 */
export interface StuckDetectionResult {
  stuckTaskIds: string[];
  staleHeartbeatTaskIds: string[];
  onTrackTaskIds: string[];
  noHeartbeatTaskIds: string[];
  totalTracked: number;
}

// ── Pure logic ────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Register a task at start time, before any heartbeat arrives.
 *
 * Sets `startedAtMs` and optionally `expectedDurationMs` (for interpolation).
 * The `expectedDurationMs` lets `interpolateProgress` estimate pct from
 * elapsed time when no heartbeat has arrived yet.
 */
export function trackProgressStart(
  map: ProgressMap,
  taskId: string,
  startedAtMs: number,
  expectedDurationMs?: number,
): ProgressMap {
  const next = new Map(map);
  next.set(taskId, {
    taskId,
    startedAtMs,
    heartbeatCount: 0,
    history: [],
    expectedDurationMs,
  });
  return next;
}

/**
 * Record a progress heartbeat for a task.
 *
 * Creates the record if it doesn't exist (defensive — the caller should
 * `trackProgressStart` first, but this handles races). Pct is clamped to [0,1].
 * History is capped to `historyCap` (default 20) most-recent heartbeats.
 *
 * Returns a NEW map (does not mutate input).
 */
export function recordProgress(
  map: ProgressMap,
  taskId: string,
  pct: number,
  nowMs: number,
  opts?: { historyCap?: number },
): ProgressMap {
  const next = new Map(map);
  const existing = next.get(taskId);
  const heartbeat: ProgressHeartbeat = { pct: clamp01(pct), ts: nowMs };
  const cap = opts?.historyCap ?? DEFAULT_HISTORY_CAP;

  if (existing) {
    const history = [...existing.history, heartbeat].slice(-cap);
    next.set(taskId, {
      ...existing,
      lastHeartbeat: heartbeat,
      heartbeatCount: existing.heartbeatCount + 1,
      history,
    });
  } else {
    next.set(taskId, {
      taskId,
      startedAtMs: nowMs,
      lastHeartbeat: heartbeat,
      heartbeatCount: 1,
      history: [heartbeat],
    });
  }
  return next;
}

/** Look up a task's progress record. */
export function getProgress(map: ProgressMap, taskId: string): ProgressRecord | undefined {
  return map.get(taskId);
}

/**
 * Is the heartbeat stale (older than maxAgeMs)?
 *
 * A task with no heartbeat is considered stale (returns true).
 */
export function isHeartbeatStale(
  record: ProgressRecord,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  if (!record.lastHeartbeat) return true;
  return nowMs - record.lastHeartbeat.ts > maxAgeMs;
}

/**
 * Estimate a task's current progress pct.
 *
 * - If a heartbeat exists, use it (most recent reported pct).
 * - If no heartbeat but `expectedDurationMs` is set, interpolate from elapsed
 *   time (clamped to [0,1]). This gives a rough estimate for tasks that
 *   haven't heartbeated yet.
 * - If no data at all, return 0 (just started).
 */
export function interpolateProgress(record: ProgressRecord, nowMs: number): number {
  if (record.lastHeartbeat) return record.lastHeartbeat.pct;
  if (record.expectedDurationMs && record.expectedDurationMs > 0) {
    const elapsed = nowMs - record.startedAtMs;
    return clamp01(elapsed / record.expectedDurationMs);
  }
  return 0;
}

/**
 * Compute the progress rate (pct per ms) from the last two heartbeats.
 *
 * A rate of 0 (or negative) means the task is stalled at the same pct —
 * useful for detecting a subagent that's heartbeating but not advancing
 * (e.g., stuck in a retry loop).
 */
export function computeProgressRate(record: ProgressRecord): number {
  if (record.history.length < 2) return 0;
  const a = record.history[record.history.length - 2];
  const b = record.history[record.history.length - 1];
  const dt = b.ts - a.ts;
  if (dt <= 0) return 0;
  return (b.pct - a.pct) / dt;
}

/**
 * Detect stuck subagents based on heartbeat freshness.
 *
 * Categorizes every tracked task:
 * - `onTrack`: recent heartbeat (within maxAgeMs).
 * - `staleHeartbeat`: had a heartbeat but it's older than maxAgeMs → stuck.
 * - `noHeartbeat`: never heartbeated. If past the grace period (started
 *   longer than maxAgeMs ago), it's stuck; otherwise it may just be slow
 *   to start.
 *
 * `stuckTaskIds` = `staleHeartbeatTaskIds` + no-heartbeat-past-grace.
 */
export function detectStuck(
  map: ProgressMap,
  maxHeartbeatAgeMs: number,
  nowMs: number,
): StuckDetectionResult {
  const stuck: string[] = [];
  const staleHeartbeat: string[] = [];
  const onTrack: string[] = [];
  const noHeartbeat: string[] = [];

  for (const [taskId, record] of map) {
    if (!record.lastHeartbeat) {
      noHeartbeat.push(taskId);
      // No heartbeat at all — stuck if past the grace period.
      if (nowMs - record.startedAtMs > maxHeartbeatAgeMs) {
        stuck.push(taskId);
      }
    } else if (nowMs - record.lastHeartbeat.ts > maxHeartbeatAgeMs) {
      staleHeartbeat.push(taskId);
      stuck.push(taskId);
    } else {
      onTrack.push(taskId);
    }
  }

  return {
    stuckTaskIds: stuck,
    staleHeartbeatTaskIds: staleHeartbeat,
    onTrackTaskIds: onTrack,
    noHeartbeatTaskIds: noHeartbeat,
    totalTracked: map.size,
  };
}
