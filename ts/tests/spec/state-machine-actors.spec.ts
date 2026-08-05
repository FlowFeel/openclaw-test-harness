/**
 * State machine actor wrapper specs.
 *
 * @dft
 * - DETERMINISTIC: pure transition functions + actor wrappers.
 * - No I/O — no file system, no network, no real processes.
 * - Tests the SubagentActor and AdaptiveSubagentActor classes
 *   (the xstate-compatible wrappers) + createActor factories.
 */
import { describe, it, expect } from "vitest";
import {
  SubagentActor,
  subagentMachine,
  createActor,
  transitionSubagent,
  TRANSITIONS,
} from "../../src/features/subagent-admission/subagent-admission.machine.js";
import {
  AdaptiveSubagentActor,
  adaptiveSubagentMachine,
  transitionAdaptiveState,
  reduceAdaptiveContext,
  ADAPTIVE_TRANSITIONS,
} from "../../src/features/subagent-admission/adaptive-machine.js";

// ── SubagentActor ────────────────────────────────────────────

describe("SubagentActor", () => {
  it("starts in 'created' state", () => {
    const actor = new SubagentActor("sub:1").start();
    expect(actor.getSnapshot().value).toBe("created");
    expect(actor.getSnapshot().context.sessionKey).toBe("sub:1");
  });

  it("transitions through a full lifecycle", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    expect(actor.getSnapshot().value).toBe("dispatched");
    actor.send({ type: "start" });
    expect(actor.getSnapshot().value).toBe("running");
    actor.send({ type: "finish" });
    expect(actor.getSnapshot().value).toBe("completed");
    actor.send({ type: "archive" });
    expect(actor.getSnapshot().value).toBe("archived");
  });

  it("context.state tracks the current state", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    expect(actor.getSnapshot().context.state).toBe("dispatched");
    actor.send({ type: "start" });
    expect(actor.getSnapshot().context.state).toBe("running");
  });

  it("invalid transitions keep current state", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "finish" }); // invalid from dispatched
    expect(actor.getSnapshot().value).toBe("dispatched");
  });

  it("archived is terminal — no transitions out", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "finish" });
    actor.send({ type: "archive" });
    actor.send({ type: "dispatch" }); // ignored
    expect(actor.getSnapshot().value).toBe("archived");
  });

  it("start() resets to 'created'", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.start();
    expect(actor.getSnapshot().value).toBe("created");
  });

  it("error transition from running → failed", () => {
    const actor = new SubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "error" });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("parent_abort from any non-terminal state → aborted", () => {
    for (const startEvent of ["dispatch", "start", "yield"] as const) {
      const actor = new SubagentActor("sub:1").start();
      actor.send({ type: "dispatch" });
      if (startEvent === "start") actor.send({ type: "start" });
      if (startEvent === "yield") {
        actor.send({ type: "start" });
        actor.send({ type: "yield" });
      }
      actor.send({ type: "parent_abort" });
      expect(actor.getSnapshot().value).toBe("aborted");
    }
  });
});

describe("subagentMachine.createActor", () => {
  it("creates an actor with the given sessionKey", () => {
    const actor = subagentMachine.createActor({ sessionKey: "sub:1" });
    expect(actor).toBeInstanceOf(SubagentActor);
    expect(actor.getSnapshot().context.sessionKey).toBe("sub:1");
    expect(actor.getSnapshot().value).toBe("created");
  });
});

describe("createActor (factory function)", () => {
  it("creates an actor via the factory", () => {
    const actor = createActor(subagentMachine, { input: { sessionKey: "sub:1" } });
    expect(actor).toBeInstanceOf(SubagentActor);
    expect(actor.getSnapshot().context.sessionKey).toBe("sub:1");
  });

  it("created actor can transition", () => {
    const actor = createActor(subagentMachine, { input: { sessionKey: "sub:1" } });
    actor.send({ type: "dispatch" });
    expect(actor.getSnapshot().value).toBe("dispatched");
  });
});

// ── AdaptiveSubagentActor ────────────────────────────────────

describe("AdaptiveSubagentActor", () => {
  it("starts in 'created' state with zero progress", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("created");
    expect(snap.context.progress).toBe(0);
    expect(snap.context.sessionKey).toBe("sub:1");
    expect(snap.context.estimatedRemainingMs).toBeNull();
    expect(snap.context.staleCount).toBe(0);
  });

  it("transitions through an adaptive lifecycle", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    expect(actor.getSnapshot().value).toBe("dispatched");
    actor.send({ type: "start" });
    expect(actor.getSnapshot().value).toBe("running");
    actor.send({ type: "report", progress: 0.5 });
    expect(actor.getSnapshot().value).toBe("running");
    expect(actor.getSnapshot().context.progress).toBe(0.5);
    actor.send({ type: "finish" });
    expect(actor.getSnapshot().value).toBe("completed");
    actor.send({ type: "archive" });
    expect(actor.getSnapshot().value).toBe("archived");
  });

  it("yield → checkpoint → completed path", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "yield" });
    expect(actor.getSnapshot().value).toBe("yielding");
    actor.send({ type: "checkpoint" });
    expect(actor.getSnapshot().value).toBe("completed");
  });

  it("yield → resume → running path", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "yield" });
    actor.send({ type: "resume" });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("report updates progress and estimatedRemainingMs", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "report", progress: 0.75, estimatedRemainingMs: 5000 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.progress).toBe(0.75);
    expect(ctx.estimatedRemainingMs).toBe(5000);
  });

  it("report without estimatedRemainingMs sets it to null", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "report", progress: 0.5 });
    expect(actor.getSnapshot().context.estimatedRemainingMs).toBeNull();
  });

  it("stale event increments staleCount (context reducer runs regardless of state)", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "stale" });
    expect(actor.getSnapshot().context.staleCount).toBe(1);
    expect(actor.getSnapshot().value).toBe("stale");
    // send another stale — state stays stale (no transition), but context still increments
    actor.send({ type: "stale" });
    expect(actor.getSnapshot().context.staleCount).toBe(2);
  });

  it("stale → report → running (recovers)", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "stale" });
    actor.send({ type: "report", progress: 0.5 });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("error transitions to failed", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "error" });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("start() resets to 'created'", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.start();
    expect(actor.getSnapshot().value).toBe("created");
  });

  it("invalid transitions keep current state", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "finish" }); // invalid from created
    expect(actor.getSnapshot().value).toBe("created");
  });

  it("archived is terminal", () => {
    const actor = new AdaptiveSubagentActor("sub:1").start();
    actor.send({ type: "dispatch" });
    actor.send({ type: "start" });
    actor.send({ type: "finish" });
    actor.send({ type: "archive" });
    actor.send({ type: "dispatch" }); // ignored
    expect(actor.getSnapshot().value).toBe("archived");
  });
});

describe("adaptiveSubagentMachine.createActor", () => {
  it("creates an AdaptiveSubagentActor", () => {
    const actor = adaptiveSubagentMachine.createActor({ sessionKey: "sub:1" });
    expect(actor).toBeInstanceOf(AdaptiveSubagentActor);
    expect(actor.getSnapshot().context.sessionKey).toBe("sub:1");
  });
});

// ── transitionAdaptiveState (exhaustive) ─────────────────────

describe("transitionAdaptiveState", () => {
  it("created → dispatched on dispatch", () => {
    expect(transitionAdaptiveState("created", "dispatch")).toBe("dispatched");
  });

  it("dispatched → running on start", () => {
    expect(transitionAdaptiveState("dispatched", "start")).toBe("running");
  });

  it("running → yielding on yield", () => {
    expect(transitionAdaptiveState("running", "yield")).toBe("yielding");
  });

  it("running → completed on finish", () => {
    expect(transitionAdaptiveState("running", "finish")).toBe("completed");
  });

  it("running → stale on stale", () => {
    expect(transitionAdaptiveState("running", "stale")).toBe("stale");
  });

  it("stale → running on report", () => {
    expect(transitionAdaptiveState("stale", "report")).toBe("running");
  });

  it("archived stays archived on any event", () => {
    for (const event of ["dispatch", "start", "report", "yield", "finish", "error", "stale", "archive"] as const) {
      expect(transitionAdaptiveState("archived", event)).toBe("archived");
    }
  });

  it("invalid transition returns current state", () => {
    expect(transitionAdaptiveState("created", "finish")).toBe("created");
    expect(transitionAdaptiveState("dispatched", "yield")).toBe("dispatched");
  });
});

// ── reduceAdaptiveContext ────────────────────────────────────

describe("reduceAdaptiveContext", () => {
  const baseContext = {
    sessionKey: "sub:1",
    progress: 0,
    lastReportAtMs: 0,
    estimatedRemainingMs: null as number | null,
    staleCount: 0,
  };

  it("report updates progress, lastReportAtMs, and estimatedRemainingMs", () => {
    const result = reduceAdaptiveContext(baseContext, { type: "report", progress: 0.5, estimatedRemainingMs: 3000 }, 1000);
    expect(result.progress).toBe(0.5);
    expect(result.lastReportAtMs).toBe(1000);
    expect(result.estimatedRemainingMs).toBe(3000);
  });

  it("report without estimatedRemainingMs sets it to null", () => {
    const ctx = { ...baseContext, estimatedRemainingMs: 5000 };
    const result = reduceAdaptiveContext(ctx, { type: "report", progress: 0.8 }, 2000);
    expect(result.estimatedRemainingMs).toBeNull();
  });

  it("stale increments staleCount", () => {
    const result = reduceAdaptiveContext({ ...baseContext, staleCount: 2 }, { type: "stale" }, 1000);
    expect(result.staleCount).toBe(3);
  });

  it("other events return context unchanged", () => {
    for (const event of [
      { type: "dispatch" as const },
      { type: "start" as const },
      { type: "yield" as const },
      { type: "checkpoint" as const },
      { type: "resume" as const },
      { type: "finish" as const },
      { type: "error" as const },
      { type: "archive" as const },
    ]) {
      const result = reduceAdaptiveContext(baseContext, event, 1000);
      expect(result).toEqual(baseContext);
    }
  });

  it("uses Date.now() as default nowMs", () => {
    const before = Date.now();
    const result = reduceAdaptiveContext(baseContext, { type: "report", progress: 0.5 }, );
    const after = Date.now();
    expect(result.lastReportAtMs).toBeGreaterThanOrEqual(before);
    expect(result.lastReportAtMs).toBeLessThanOrEqual(after);
  });
});

// ── Transition table structure ───────────────────────────────

describe("transition table structure", () => {
  it("TRANSITIONS has all subagent states", () => {
    expect(TRANSITIONS.created.dispatch).toBe("dispatched");
    expect(TRANSITIONS.archived).toEqual({});
  });

  it("ADAPTIVE_TRANSITIONS has all adaptive states", () => {
    expect(ADAPTIVE_TRANSITIONS.created.dispatch).toBe("dispatched");
    expect(ADAPTIVE_TRANSITIONS.archived).toEqual({});
  });
});
