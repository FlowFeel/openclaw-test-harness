/**
 * Transient Step Rollup Logic (T-583) — pure logic for squashing large
 * intermediate discovery/inspection tool-result bursts into atomic summaries.
 *
 * @behavior
 * - Segments a transcript slice into runs (bursts) of consecutive transient
 *   discovery/inspection tool results (exec, read, grep, poll-style checks…).
 * - Bursts at or above a minimum size are replaced by ONE atomic summary
 *   entry; smaller bursts and non-transient entries pass through untouched.
 * - Tracks per-turn burst statistics so the turn-finalization hook can report
 *   what was squashed without interrupting reasoning mid-turn: during the
 *   turn, tool results persist normally; the rollup is applied only at
 *   turn end (agent_end).
 *
 * @invariants
 * - Pure logic: no I/O, no timers, no Date.now()/Math.random().
 * - Same input → same output for every function.
 * - rollupTransientSteps never mutates its input array; it returns a new one.
 * - All mutating-style functions return a report (CheckResult pattern).
 *
 * @dft
 * - Tested in rollup-logic.spec.ts with inline transcript fixtures.
 * - Fully deterministic: no clock, no randomness.
 */

export const DEFAULT_TRANSIENT_TOOLS: readonly string[] = [
  "exec",
  "bash",
  "process",
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "list",
  "task_status",
  "task_output",
  "session_health",
];

/** Minimum consecutive transient results before a burst is squashed. */
export const DEFAULT_MIN_BURST_SIZE = 6;

/** Characters preserved from the final result of a rolled-up burst. */
export const DEFAULT_ROLLUP_TAIL_CHARS = 240;

/** Tool name stamped on synthetic rollup summary entries. */
export const ROLLUP_TOOL_NAME = "session_guard_rollup";

export interface RollupOptions {
  /** Tool names treated as transient discovery/inspection steps. */
  transientTools?: string[];
  /** Minimum burst size before a burst is squashed (default 6). */
  minBurstSize?: number;
  /** Tail characters preserved from the final result of a burst. */
  tailChars?: number;
}

export interface RollupReport {
  changed: boolean;
  /** Number of bursts replaced by atomic summaries. */
  burstsRolled: number;
  /** Number of entries removed (replaced by fewer summary entries). */
  entriesRemoved: number;
  charsBefore: number;
  charsAfter: number;
  summaries: string[];
}

// ── Transcript entry normalization ──────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extracts the message body of a transcript entry (direct or nested). */
function innerMessage(entry: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(entry.message);
  return nested ?? entry;
}

/** Extracts the text of a transcript entry from string or content-array form. */
export function extractEntryText(entry: unknown): string {
  const msg = asRecord(entry);
  if (!msg) return "";
  const inner = innerMessage(msg);
  if (typeof inner.content === "string") return inner.content;
  if (Array.isArray(inner.content)) {
    let text = "";
    for (const item of inner.content) {
      const rec = asRecord(item);
      if (rec && typeof rec.text === "string") text += rec.text + "\n";
    }
    return text;
  }
  return "";
}

/** Extracts the tool name of a transcript entry, if any. */
export function extractEntryToolName(entry: unknown): string | undefined {
  const msg = asRecord(entry);
  if (!msg) return undefined;
  const direct = msg.toolName;
  if (typeof direct === "string") return direct;
  const inner = innerMessage(msg);
  const nested = inner.toolName;
  return typeof nested === "string" ? nested : undefined;
}

/** True when the entry is a tool result (as opposed to user/assistant text). */
export function isToolResultEntry(entry: unknown): boolean {
  const msg = asRecord(entry);
  if (!msg) return false;
  const inner = innerMessage(msg);
  const role = inner.role ?? msg.role;
  if (role === "toolResult") return true;
  // Entries with a toolName but no role are treated as tool results too.
  return role === undefined && extractEntryToolName(entry) !== undefined;
}

/** True when the tool name is a transient discovery/inspection tool. */
export function isTransientToolName(toolName: string | undefined, tools: readonly string[]): boolean {
  if (!toolName) return false;
  return tools.includes(toolName);
}

// ── Burst segmentation ──────────────────────────────────────────────

/** A contiguous run of transient tool results within a transcript slice. */
export interface BurstSegment {
  start: number;
  endExclusive: number;
  size: number;
  /** Whether this segment qualifies for rollup (size >= minBurstSize). */
  rollup: boolean;
}

/**
 * Segments a transcript slice into bursts of consecutive transient
 * discovery/inspection tool results. Any non-toolResult or non-transient
 * entry breaks a burst. Pure: input is never mutated.
 */
export function segmentTransientBursts(
  entries: unknown[],
  options?: RollupOptions,
): BurstSegment[] {
  const tools = options?.transientTools ?? DEFAULT_TRANSIENT_TOOLS;
  const minBurstSize = options?.minBurstSize ?? DEFAULT_MIN_BURST_SIZE;

  const segments: BurstSegment[] = [];
  let start = -1;

  for (let i = 0; i <= entries.length; i++) {
    const entry = i < entries.length ? entries[i] : undefined;
    const transient =
      entry !== undefined &&
      isToolResultEntry(entry) &&
      isTransientToolName(extractEntryToolName(entry), tools);
    if (transient) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      segments.push({ start, endExclusive: i, size: i - start, rollup: i - start >= minBurstSize });
      start = -1;
    }
  }
  return segments;
}

// ── Atomic summary formatting ───────────────────────────────────────

/** Builds a compact per-tool count string like "exec×4, read×2". */
export function formatToolCounts(entries: unknown[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = extractEntryToolName(entry) ?? "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

/** Collapses whitespace so a result tail fits on one summary line. */
function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Formats the atomic summary for one qualifying burst. Preserves the tool
 * mix and the tail of the final result so follow-up reasoning keeps its
 * anchor point.
 */
export function formatRollupSummary(
  burstEntries: unknown[],
  options?: RollupOptions,
): string {
  const tailChars = options?.tailChars ?? DEFAULT_ROLLUP_TAIL_CHARS;
  const counts = formatToolCounts(burstEntries);
  const lastText = flattenText(extractEntryText(burstEntries[burstEntries.length - 1]));
  const tail = lastText.length > tailChars ? `…${lastText.slice(-tailChars)}` : lastText;
  const tailPart = tail ? `; final result (${tail.length} chars shown): "${tail}"` : "";
  return (
    `[oc-session-guard rollup] ${burstEntries.length} transient discovery/inspection ` +
    `tool results (${counts}) squashed into this atomic summary at turn end${tailPart}`
  );
}

// ── Rollup transformation ───────────────────────────────────────────

/**
 * Squashes qualifying bursts of transient tool results into atomic summary
 * entries. Returns a NEW array; the input is never mutated.
 */
export function rollupTransientSteps(
  entries: unknown[],
  options?: RollupOptions,
): { entries: unknown[]; report: RollupReport } {
  const minBurstSize = options?.minBurstSize ?? DEFAULT_MIN_BURST_SIZE;
  const segments = segmentTransientBursts(entries, options);

  const charsBefore = entries.reduce<number>((acc, e) => acc + extractEntryText(e).length, 0);
  const out: unknown[] = [];
  const summaries: string[] = [];
  let removed = 0;
  let cursor = 0;

  for (const seg of segments) {
    if (!seg.rollup) continue;
    for (let i = cursor; i < seg.start; i++) out.push(entries[i]);
    const burst = entries.slice(seg.start, seg.endExclusive);
    const summary = formatRollupSummary(burst, options);
    summaries.push(summary);
    out.push({
      role: "toolResult",
      toolName: ROLLUP_TOOL_NAME,
      content: [{ type: "text", text: summary }],
    });
    removed += burst.length - 1;
    cursor = seg.endExclusive;
  }
  for (let i = cursor; i < entries.length; i++) out.push(entries[i]);

  const charsAfter = out.reduce<number>((acc, e) => acc + extractEntryText(e).length, 0);
  const changed = removed > 0;
  return {
    entries: out,
    report: {
      changed,
      burstsRolled: summaries.length,
      entriesRemoved: removed,
      charsBefore,
      charsAfter,
      summaries,
    },
  };
}

// ── Per-turn burst tracking (wiring support) ────────────────────────

/**
 * In-memory per-turn tracker. The wiring layer records every persisted tool
 * result here WITHOUT touching the message — reasoning is never interrupted
 * mid-turn. The turn-finalization hook (agent_end) closes the final burst
 * and reports what the turn accumulated.
 */
export interface TurnBurstTracker {
  currentBurst: number;
  largestBurst: number;
  totalTransient: number;
  closedBursts: number;
  /** Burst sizes of closed qualifying bursts (>= minBurstSize). */
  qualifyingBurstSizes: number[];
}

export function createTurnBurstTracker(): TurnBurstTracker {
  return {
    currentBurst: 0,
    largestBurst: 0,
    totalTransient: 0,
    closedBursts: 0,
    qualifyingBurstSizes: [],
  };
}

/**
 * Records one persisted tool result against the tracker. Pure: returns the
 * next tracker state. Non-transient results close the current burst.
 */
export function recordToolResultForRollup(
  tracker: TurnBurstTracker,
  toolName: string | undefined,
  options?: RollupOptions,
): { tracker: TurnBurstTracker; counted: boolean } {
  const tools = options?.transientTools ?? DEFAULT_TRANSIENT_TOOLS;
  const minBurstSize = options?.minBurstSize ?? DEFAULT_MIN_BURST_SIZE;

  if (isTransientToolName(toolName, tools)) {
    const currentBurst = tracker.currentBurst + 1;
    return {
      tracker: {
        ...tracker,
        currentBurst,
        largestBurst: Math.max(tracker.largestBurst, currentBurst),
        totalTransient: tracker.totalTransient + 1,
      },
      counted: true,
    };
  }

  // Non-transient tool result: close the current burst if one is open.
  if (tracker.currentBurst === 0) {
    return { tracker, counted: false };
  }
  const qualifying = tracker.currentBurst >= minBurstSize;
  return {
    tracker: {
      ...tracker,
      currentBurst: 0,
      closedBursts: tracker.closedBursts + 1,
      qualifyingBurstSizes: qualifying
        ? [...tracker.qualifyingBurstSizes, tracker.currentBurst]
        : tracker.qualifyingBurstSizes,
    },
    counted: false,
  };
}

/** Finalizes a turn: closes any open burst and reports rollup statistics. */
export function finalizeTurnRollup(
  tracker: TurnBurstTracker,
  options?: RollupOptions,
): {
  shouldRollup: boolean;
  largestBurst: number;
  totalTransient: number;
  totalBursts: number;
  qualifyingBurstSizes: number[];
} {
  const minBurstSize = options?.minBurstSize ?? DEFAULT_MIN_BURST_SIZE;
  const openQualifies = tracker.currentBurst >= minBurstSize;
  const qualifyingBurstSizes = openQualifies
    ? [...tracker.qualifyingBurstSizes, tracker.currentBurst]
    : tracker.qualifyingBurstSizes;
  return {
    shouldRollup: qualifyingBurstSizes.length > 0,
    largestBurst: Math.max(tracker.largestBurst, tracker.currentBurst),
    totalTransient: tracker.totalTransient,
    totalBursts: tracker.closedBursts + (tracker.currentBurst > 0 ? 1 : 0),
    qualifyingBurstSizes,
  };
}
