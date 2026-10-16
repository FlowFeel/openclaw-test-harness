/**
 * Event-Push Logic (M1) Unit Tests.
 *
 * @dft
 * - Pure: inline test data, zero filesystem/network access.
 * - Deterministic: mock timestamps injected into functions.
 * - Comprehensive coverage of all decision branches.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateEventPush,
  formatEventPushCue,
  matchesEvent,
  cleanExpiredSessionHolds,
  createInitialSessionHoldState,
  buildEventPushIdempotencyKey,
  type EventPushTriggerEvent,
} from "../src/event-push-logic.js";
import { createRegistry, type MemoryNote } from "../src/memory-recall-logic.js";

function makeNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "note-1",
    valid: true,
    raw: "",
    content: "content",
    frontmatter: {
      kind: "silent_trap",
      use_when: "dealing with postgres deadlock",
      does_not_apply_when: "mysql",
      provenance: "PR #12",
      source: "docs/traps/deadlock.md",
      ...overrides.frontmatter,
    },
    ...overrides,
  };
}

describe("Event-Push Logic (Deliverable 4 - M1)", () => {
  it("matches note by source path in tool params", () => {
    const note = makeNote({
      frontmatter: {
        kind: "procedure",
        use_when: "updating migration",
        does_not_apply_when: "",
        provenance: "",
        source: "schema/migrations.sql",
      },
    });

    const event: EventPushTriggerEvent = {
      toolName: "read_file",
      params: { path: "/app/schema/migrations.sql" },
    };

    expect(matchesEvent(note, event)).toBe(true);
  });

  it("matches note by error keywords for silent_trap", () => {
    const note = makeNote({
      frontmatter: {
        kind: "silent_trap",
        use_when: "postgres transaction deadlock retry",
        does_not_apply_when: "",
        provenance: "",
        source: "traps/pg.md",
      },
    });

    const event: EventPushTriggerEvent = {
      toolName: "run_sql",
      error: "ERROR: deadlock detected in transaction 1024",
    };

    expect(matchesEvent(note, event)).toBe(true);
  });

  it("does not match when event content is unrelated", () => {
    const note = makeNote({
      frontmatter: {
        kind: "silent_trap",
        use_when: "kafka partition rebalance",
        does_not_apply_when: "",
        provenance: "",
        source: "traps/kafka.md",
      },
    });

    const event: EventPushTriggerEvent = {
      toolName: "read_file",
      params: { path: "src/utils.ts" },
      result: "export function add(a, b) { return a + b; }",
    };

    expect(matchesEvent(note, event)).toBe(false);
  });

  it("formats factual memory cue without preachy guardrails", () => {
    const note = makeNote({
      id: "trap-pg",
      frontmatter: {
        kind: "silent_trap",
        use_when: "retry deadlock with exponential backoff",
        does_not_apply_when: "read-only queries",
        provenance: "Incident #402",
        source: "docs/deadlock.md",
      },
    });

    const cue = formatEventPushCue(note, "hold-once");
    expect(cue).toContain("# [MEMORY CUE] Relevant memory note for current workflow (silent_trap):");
    expect(cue).toContain("• docs/deadlock.md — retry deadlock with exponential backoff");
    expect(cue).not.toContain("Do not");
    expect(cue).not.toContain("Never");
  });

  it("enforces hold-once policy: pushes on first occurrence, suppresses on second in same session", () => {
    const note = makeNote({ id: "trap-1" });
    const registry = createRegistry([note]);

    const event: EventPushTriggerEvent = {
      toolName: "run_command",
      sessionKey: "session-a",
      error: "deadlock detected",
    };

    const initialHolds = createInitialSessionHoldState();

    // 1. First event at t=1000ms -> should push
    const d1 = evaluateEventPush(registry, event, initialHolds, 1000);
    expect(d1.shouldPush).toBe(true);
    expect(d1.notesToPush).toHaveLength(1);
    expect(d1.notesToPush[0].idempotencyKey).toBe("m1-hold-session-a-trap-1");
    expect(d1.suppressedNoteIds).toHaveLength(0);

    // 2. Second event at t=2000ms in session-a -> suppressed by hold-once
    const d2 = evaluateEventPush(registry, event, d1.newHoldState, 2000);
    expect(d2.shouldPush).toBe(false);
    expect(d2.notesToPush).toHaveLength(0);
    expect(d2.suppressedNoteIds).toEqual(["trap-1"]);

    // 3. Event in session-b -> eligible (different session)
    const eventB: EventPushTriggerEvent = { ...event, sessionKey: "session-b" };
    const d3 = evaluateEventPush(registry, eventB, d1.newHoldState, 2000);
    expect(d3.shouldPush).toBe(true);
    expect(d3.notesToPush).toHaveLength(1);
  });

  it("releases hold-once after TTL expires", () => {
    const note = makeNote({ id: "trap-1" });
    const registry = createRegistry([note]);

    const event: EventPushTriggerEvent = {
      toolName: "run_command",
      sessionKey: "session-a",
      error: "deadlock detected",
    };

    const initialHolds = createInitialSessionHoldState();
    const d1 = evaluateEventPush(registry, event, initialHolds, 1000, { holdOnceTtlMs: 60_000 });

    // At t=30s (within 60s TTL): suppressed
    const d2 = evaluateEventPush(registry, event, d1.newHoldState, 30_000, { holdOnceTtlMs: 60_000 });
    expect(d2.shouldPush).toBe(false);

    // At t=65s (past 60s TTL): eligible again
    const d3 = evaluateEventPush(registry, event, d1.newHoldState, 65_000, { holdOnceTtlMs: 60_000 });
    expect(d3.shouldPush).toBe(true);
    expect(d3.notesToPush).toHaveLength(1);
  });

  it("allows let-run policy to fire repeatedly across turns", () => {
    const note = makeNote({
      id: "advisory-1",
      frontmatter: {
        kind: "external_dep",
        use_when: "third-party api; rate limit",
        does_not_apply_when: "",
        provenance: "",
        source: "deps/api.md",
        delivery_policy: "let-run",
      },
    });
    const registry = createRegistry([note]);

    const event: EventPushTriggerEvent = {
      toolName: "fetch_api",
      sessionKey: "session-a",
      result: "third-party api call response",
    };

    const initialHolds = createInitialSessionHoldState();

    // Turn 1
    const d1 = evaluateEventPush(registry, event, initialHolds, 1000);
    expect(d1.shouldPush).toBe(true);

    // Turn 2 in same session: let-run is NOT suppressed by hold-once
    const d2 = evaluateEventPush(registry, event, d1.newHoldState, 2000);
    expect(d2.shouldPush).toBe(true);
    expect(d2.notesToPush[0].policy).toBe("let-run");
  });

  it("cleans expired session holds", () => {
    const state = {
      holds: {
        "session-1": {
          "note-old": { noteId: "note-old", kind: "k", enqueuedAtMs: 1000, policy: "hold-once" as const },
          "note-recent": { noteId: "note-recent", kind: "k", enqueuedAtMs: 50_000, policy: "hold-once" as const },
        },
      },
    };

    const cleaned = cleanExpiredSessionHolds(state, 60_000, 30_000); // threshold is 30s
    expect(cleaned.holds["session-1"]["note-old"]).toBeUndefined();
    expect(cleaned.holds["session-1"]["note-recent"]).toBeDefined();
  });
});
