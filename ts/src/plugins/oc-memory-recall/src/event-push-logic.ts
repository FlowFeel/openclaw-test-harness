/**
 * Event-Push Logic (Deliverable 4 - M1) — pure decision logic.
 *
 * @behavior
 * Pure decision logic for the user-channel event push arm (M1):
 * - Evaluates post-tool execution events against the memory note registry.
 * - Enforces "hold-once" vs "let-run" delivery policies.
 * - Tracks session-scoped hold state with TTL safety ceiling (30-60 min).
 * - Generates deterministic idempotency keys and concise factual signpost cues.
 *
 * @invariants
 * - Pure: same input -> same output, zero side-effects.
 * - Zero I/O builtins (no node:fs, node:path, fetch).
 * - Zero non-deterministic calls (no Date.now(), Math.random(), new Date()).
 * - Zero auxiliary model calls: all decisions are deterministic host compute.
 *
 * @dft
 * - Tested with inline mock data and zero filesystem fixtures.
 */

import { projectCueLine, resolvePointer, type MemoryNote, type NoteRegistry } from "./memory-recall-logic.js";
import { TOKEN_SPLIT_REGEX, PHRASE_SPLIT_REGEX } from "../../shared/regex-library.ts";

export type DeliveryPolicy = "hold-once" | "let-run";

export interface EventPushTriggerEvent {
  toolName: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  sessionKey?: string;
}

export interface HoldRecord {
  noteId: string;
  kind: string;
  enqueuedAtMs: number;
  policy: DeliveryPolicy;
}

export interface SessionHoldState {
  /** sessionKey -> noteId -> HoldRecord */
  holds: Record<string, Record<string, HoldRecord>>;
}

export interface EventPushOptions {
  defaultPolicy?: DeliveryPolicy;
  /** Hold-once safety ceiling in milliseconds (default: 30 minutes = 1,800,000ms). */
  holdOnceTtlMs?: number;
}

export interface PushedNoteItem {
  note: MemoryNote;
  policy: DeliveryPolicy;
  cueText: string;
  idempotencyKey: string;
}

export interface EventPushDecision {
  shouldPush: boolean;
  notesToPush: PushedNoteItem[];
  newHoldState: SessionHoldState;
  suppressedNoteIds: string[];
}

export const DEFAULT_HOLD_ONCE_TTL_MS = 1_800_000; // 30 minutes

export function createInitialSessionHoldState(): SessionHoldState {
  return { holds: {} };
}

/**
 * Extracts all string search tokens from tool parameters, result, and error.
 */
function extractEventTextTokens(event: EventPushTriggerEvent): string[] {
  const tokens: string[] = [];

  function walk(val: unknown) {
    if (!val) return;
    switch (typeof val) {
      case "string":
        tokens.push(val.toLowerCase());
        break;
      case "object":
        if (Array.isArray(val)) {
          for (const item of val) walk(item);
        } else {
          for (const v of Object.values(val as Record<string, unknown>)) {
            walk(v);
          }
        }
        break;
      default:
        break;
    }
  }

  walk(event.params);
  walk(event.result);
  if (event.error) {
    tokens.push(event.error.toLowerCase());
  }

  return tokens;
}

/**
 * Determines whether a memory note matches a tool execution event.
 */
export function matchesEvent(note: MemoryNote, event: EventPushTriggerEvent): boolean {
  if (!note.valid) return false;

  const eventTokens = extractEventTextTokens(event);
  const combinedEventText = eventTokens.join(" ");

  // 1. Path match: note source or paths appear in event parameters/result
  const source = note.frontmatter.source?.toLowerCase().trim();
  if (source && combinedEventText.includes(source)) {
    return true;
  }

  if (Array.isArray(note.frontmatter.paths)) {
    for (const p of note.frontmatter.paths) {
      const normP = String(p).toLowerCase().trim();
      if (normP && combinedEventText.includes(normP)) {
        return true;
      }
    }
  }

  // 2. Error / trap match: if tool errored, match silent_trap or workaround
  if (event.error) {
    if (note.frontmatter.kind === "silent_trap" || note.frontmatter.kind === "workaround") {
      const useWhen = note.frontmatter.use_when.toLowerCase();
      // Token match: check if any keyword from use_when appears in the error
      const words = useWhen.split(TOKEN_SPLIT_REGEX as RegExp).filter((w) => w.length > 3);
      if (words.some((w) => combinedEventText.includes(w))) {
        return true;
      }
    }
  }

  // 3. Keyword trigger: match key terms from note use_when
  const useWhen = note.frontmatter.use_when.toLowerCase();
  if (useWhen.length > 0) {
    const triggerPhrases = useWhen
      .split(PHRASE_SPLIT_REGEX as RegExp)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const phrase of triggerPhrases) {
      if (combinedEventText.includes(phrase)) {
        return true;
      }
    }
  }

  // 4. Schema v2 event matching: match trigger string
  if (note.frontmatter.event) {
    const ev = String(note.frontmatter.event).toLowerCase().trim();
    if (ev.length > 0 && combinedEventText.includes(ev)) {
      return true;
    }
  }

  return false;
}

/**
 * Formats a factual, objective memory cue for turn injection.
 * Zero negative guardrail lecturing.
 */
export function formatEventPushCue(
  note: MemoryNote,
  policy: DeliveryPolicy
): string {
  if (note.frontmatter.event) {
    const cue = projectCueLine(note, { arm: "event_push" });
    return (
      `# [MEMORY CUE] Relevant memory note for current workflow (${note.frontmatter.kind}):\n` +
      `• ${cue.cueText}`
    );
  }

  const { pointer, context } = resolvePointer(note);
  const contextSuffix = context ? ` — via: ${context}` : "";
  const useWhen = note.frontmatter.use_when ? ` — ${note.frontmatter.use_when}` : "";
  return (
    `# [MEMORY CUE] Relevant memory note for current workflow (${note.frontmatter.kind}):\n` +
    `• ${pointer}${contextSuffix}${useWhen}`
  );
}

/**
 * Builds an idempotency key for next turn injection.
 */
export function buildEventPushIdempotencyKey(
  sessionKey: string,
  noteId: string,
  policy: DeliveryPolicy,
  nowMs: number
): string {
  if (policy === "hold-once") {
    return `m1-hold-${sessionKey}-${noteId}`;
  }
  const windowBucket = Math.floor(nowMs / 60_000);
  return `m1-run-${sessionKey}-${noteId}-${windowBucket}`;
}

/**
 * Pure evaluation of an event push trigger against note registry and hold state.
 */
export function evaluateEventPush(
  registry: NoteRegistry,
  event: EventPushTriggerEvent,
  holdState: SessionHoldState,
  nowMs: number,
  options?: EventPushOptions
): EventPushDecision {
  const sessionKey = event.sessionKey ?? "default-session";
  const defaultPolicy = options?.defaultPolicy ?? "hold-once";
  const holdOnceTtlMs = options?.holdOnceTtlMs ?? DEFAULT_HOLD_ONCE_TTL_MS;

  const currentSessionHolds = holdState.holds[sessionKey] ?? {};
  const nextSessionHolds: Record<string, HoldRecord> = { ...currentSessionHolds };

  const notesToPush: PushedNoteItem[] = [];
  const suppressedNoteIds: string[] = [];

  for (const note of registry.notes.values()) {
    if (!matchesEvent(note, event)) {
      continue;
    }

    // Determine delivery policy
    const policy: DeliveryPolicy =
      note.frontmatter.delivery_policy === "let-run" || note.frontmatter.delivery_policy === "hold-once"
        ? note.frontmatter.delivery_policy
        : defaultPolicy;

    if (policy === "hold-once") {
      const existing = currentSessionHolds[note.id];
      if (existing) {
        const isExpired = nowMs - existing.enqueuedAtMs >= holdOnceTtlMs;
        if (!isExpired) {
          suppressedNoteIds.push(note.id);
          continue;
        }
      }

      // Record hold
      nextSessionHolds[note.id] = {
        noteId: note.id,
        kind: String(note.frontmatter.kind),
        enqueuedAtMs: nowMs,
        policy,
      };
    }

    notesToPush.push({
      note,
      policy,
      cueText: formatEventPushCue(note, policy),
      idempotencyKey: buildEventPushIdempotencyKey(sessionKey, note.id, policy, nowMs),
    });
  }

  const newHoldState: SessionHoldState = {
    holds: {
      ...holdState.holds,
      [sessionKey]: nextSessionHolds,
    },
  };

  return {
    shouldPush: notesToPush.length > 0,
    notesToPush,
    newHoldState,
    suppressedNoteIds,
  };
}

/**
 * Purges expired hold records from session hold state.
 */
export function cleanExpiredSessionHolds(
  state: SessionHoldState,
  nowMs: number,
  ttlMs = DEFAULT_HOLD_ONCE_TTL_MS
): SessionHoldState {
  const nextHolds: Record<string, Record<string, HoldRecord>> = {};
  let changed = false;

  for (const [sKey, sessionHolds] of Object.entries(state.holds)) {
    const cleanedSession: Record<string, HoldRecord> = {};
    for (const [nId, record] of Object.entries(sessionHolds)) {
      if (nowMs - record.enqueuedAtMs < ttlMs) {
        cleanedSession[nId] = record;
      } else {
        changed = true;
      }
    }
    if (Object.keys(cleanedSession).length > 0) {
      nextHolds[sKey] = cleanedSession;
    } else {
      changed = true;
    }
  }

  return changed ? { holds: nextHolds } : state;
}
