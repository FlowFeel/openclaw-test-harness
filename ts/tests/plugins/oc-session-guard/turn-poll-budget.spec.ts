import { describe, it, expect } from "vitest";
import {
  evaluateTurnPollBudget,
  createInitialTurnPollState,
  DEFAULT_POLL_BUDGET_MS,
  type TurnPollState,
} from "../../../src/plugins/oc-session-guard/src/poll-hygiene-logic.js";

describe("T-585: Turn-Level Polling Budget", () => {
  it("allows polls while within budget and accumulates timeoutMs", () => {
    let state = createInitialTurnPollState();
    expect(state.cumulativePollMs).toBe(0);

    const v1 = evaluateTurnPollBudget(state, 30000);
    expect(v1.allowed).toBe(true);
    expect(v1.cumulativePollMs).toBe(30000);
    expect(v1.nextState.pollCount).toBe(1);
    state = v1.nextState;

    const v2 = evaluateTurnPollBudget(state, 30000);
    expect(v2.allowed).toBe(true);
    expect(v2.cumulativePollMs).toBe(60000);
    expect(v2.nextState.pollCount).toBe(2);
    state = v2.nextState;

    const v3 = evaluateTurnPollBudget(state, 30000);
    expect(v3.allowed).toBe(true);
    expect(v3.cumulativePollMs).toBe(90000);
    state = v3.nextState;

    // Next 10s poll exceeds 90s budget -> blocked
    const v4 = evaluateTurnPollBudget(state, 10000);
    expect(v4.allowed).toBe(false);
    expect(v4.error?.error).toBe("POLL_BUDGET_EXHAUSTED");
    expect(v4.error?.message).toContain("Cumulative synchronous polling in this turn has reached 90s");
    // State is not incremented on blocked call
    expect(v4.nextState.cumulativePollMs).toBe(90000);
  });

  it("handles custom turnPollBudgetMs configuration", () => {
    const state = createInitialTurnPollState();
    const customConfig = { turnPollBudgetMs: 45000 };

    const v1 = evaluateTurnPollBudget(state, 30000, customConfig);
    expect(v1.allowed).toBe(true);

    const v2 = evaluateTurnPollBudget(v1.nextState, 20000, customConfig);
    expect(v2.allowed).toBe(false);
    expect(v2.error?.error).toBe("POLL_BUDGET_EXHAUSTED");
  });

  it("bypasses check when enableTurnPollBudget is false", () => {
    const state = createInitialTurnPollState();
    const config = { enableTurnPollBudget: false };

    const v1 = evaluateTurnPollBudget(state, 120000, config);
    expect(v1.allowed).toBe(true);
    expect(v1.cumulativePollMs).toBe(120000);
  });

  it("resets state cleanly between turns", () => {
    let state = createInitialTurnPollState();
    state = evaluateTurnPollBudget(state, 80000).nextState;
    expect(state.cumulativePollMs).toBe(80000);

    // New turn begins -> fresh initial state
    state = createInitialTurnPollState();
    expect(state.cumulativePollMs).toBe(0);
    const v = evaluateTurnPollBudget(state, 30000);
    expect(v.allowed).toBe(true);
    expect(v.cumulativePollMs).toBe(30000);
  });
});
