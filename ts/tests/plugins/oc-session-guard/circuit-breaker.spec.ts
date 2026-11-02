import { describe, it, expect } from "vitest";
import {
  evaluatePreToolCallCircuitBreaker,
  recordToolCallOutcome,
  hashToolParams,
  createInitialCircuitBreakerState,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
} from "../../../src/plugins/oc-session-guard/src/tool-result-hygiene-logic.js";

describe("T-586: Tool Parameter Circuit Breaker", () => {
  it("generates deterministic param hashes regardless of key order", () => {
    const p1 = { action: "log", sessionId: "abc", limit: 10 };
    const p2 = { limit: 10, sessionId: "abc", action: "log" };
    expect(hashToolParams(p1)).toBe(hashToolParams(p2));
  });

  it("trips circuit breaker after consecutive identical failures (threshold = 2)", () => {
    let state = createInitialCircuitBreakerState();
    const badParams = { action: "log" }; // missing sessionId

    // Pre-call 1: not blocked
    const pre1 = evaluatePreToolCallCircuitBreaker(state, "process", badParams);
    expect(pre1.blocked).toBe(false);

    // Call 1 fails
    const post1 = recordToolCallOutcome(state, "process", badParams, {
      isError: true,
      errorMessage: "sessionId is required for this action.",
    });
    expect(post1.tripped).toBe(false);
    state = post1.state;

    // Pre-call 2: not blocked yet (count = 1 < threshold 2)
    const pre2 = evaluatePreToolCallCircuitBreaker(state, "process", badParams);
    expect(pre2.blocked).toBe(false);

    // Call 2 fails identically
    const post2 = recordToolCallOutcome(state, "process", badParams, {
      isError: true,
      errorMessage: "sessionId is required for this action.",
    });
    expect(post2.tripped).toBe(true);
    state = post2.state;

    // Pre-call 3: BLOCKED by circuit breaker
    const pre3 = evaluatePreToolCallCircuitBreaker(state, "process", badParams);
    expect(pre3.blocked).toBe(true);
    expect(pre3.error?.error).toBe("IDENTICAL_ARGUMENT_ERROR_LOOP");
    expect(pre3.error?.message).toContain("sessionId is required for this action.");
  });

  it("resets circuit breaker when tool parameters change", () => {
    let state = createInitialCircuitBreakerState();
    const badParams = { action: "log" };

    // Accumulate 2 failures
    state = recordToolCallOutcome(state, "process", badParams, {
      isError: true,
      errorMessage: "sessionId is required",
    }).state;
    state = recordToolCallOutcome(state, "process", badParams, {
      isError: true,
      errorMessage: "sessionId is required",
    }).state;

    // A call with corrected parameters is not blocked
    const goodParams = { action: "log", sessionId: "sess-123" };
    const preCorrected = evaluatePreToolCallCircuitBreaker(state, "process", goodParams);
    expect(preCorrected.blocked).toBe(false);

    // Success with corrected params clears the failure state
    state = recordToolCallOutcome(state, "process", goodParams, { isError: false }).state;
    expect(state.lastFailure).toBeUndefined();

    // Now even the old bad params start fresh from count 0
    const preOld = evaluatePreToolCallCircuitBreaker(state, "process", badParams);
    expect(preOld.blocked).toBe(false);
  });

  it("respects custom maxConsecutiveIdenticalErrors setting", () => {
    let state = createInitialCircuitBreakerState();
    const config = { maxConsecutiveIdenticalErrors: 3 };
    const params = { foo: "bar" };

    state = recordToolCallOutcome(state, "exec", params, { isError: true }, config).state;
    state = recordToolCallOutcome(state, "exec", params, { isError: true }, config).state;

    // Threshold is 3, so not blocked at 2
    expect(evaluatePreToolCallCircuitBreaker(state, "exec", params, config).blocked).toBe(false);

    state = recordToolCallOutcome(state, "exec", params, { isError: true }, config).state;
    // Blocked at 3
    expect(evaluatePreToolCallCircuitBreaker(state, "exec", params, config).blocked).toBe(true);
  });
});
