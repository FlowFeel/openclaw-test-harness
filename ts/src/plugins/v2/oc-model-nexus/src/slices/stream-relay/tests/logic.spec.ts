/**
 * Tier 1 Unit Spec: oc-model-nexus / stream-relay slice.
 *
 * @dft Pure unit tests — zero I/O, zero clocks, zero mocks.
 */

import { describe, it, expect } from "vitest";
import { createRelayState } from "../state.js";
import { shouldRelay, shouldRelayFallback, recordRelayOutcome, formatRelayHealth } from "../logic.js";

describe("oc-model-nexus / slices/stream-relay (Tier 1 Unit)", () => {
  it("evaluates relay routing and fallback boundaries", () => {
    expect(shouldRelay("openai/gpt-4o", true, false)).toBe(true);
    expect(shouldRelay("openai/gpt-4o", false, true)).toBe(true);
    expect(shouldRelay("openai/gpt-4o", false, false)).toBe(false);
    expect(shouldRelay("", true, true)).toBe(false);

    expect(shouldRelayFallback(false, true, 0, 3)).toBe(true);
    expect(shouldRelayFallback(true, true, 3, 3)).toBe(true);
    expect(shouldRelayFallback(true, true, 1, 3)).toBe(false);
    expect(shouldRelayFallback(false, false, 0, 3)).toBe(false);
  });

  it("tracks relay counters, average latency, and fallback entry immutably", () => {
    const cfg = { sidecarPort: 18900, fallbackEnabled: true, maxRetries: 2 };
    let state = createRelayState(18900, 1000);

    const t1 = recordRelayOutcome(state, { success: true, latencyMs: 100 }, cfg);
    state = t1.nextState;
    expect(state.totalRelayed).toBe(1);
    expect(state.avgLatencyMs).toBe(100);
    expect(t1.enteredFallback).toBe(false);

    const t2 = recordRelayOutcome(state, { success: false, latencyMs: 300 }, cfg);
    state = t2.nextState;
    expect(t2.enteredFallback).toBe(false);

    const t3 = recordRelayOutcome(state, { success: false, latencyMs: 500 }, cfg);
    state = t3.nextState;
    expect(t3.enteredFallback).toBe(true);
    expect(state.fallbackMode).toBe(true);
    expect(state.fallbackCount).toBe(1);

    const health = formatRelayHealth(state, 6000);
    expect(health.uptimeSeconds).toBe(5);
    expect(health.totalFailed).toBe(2);
  });
});
