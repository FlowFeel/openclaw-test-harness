/**
 * Tier 1 Unit Spec: oc-model-nexus / model-routing slice.
 *
 * @dft Pure unit tests — zero I/O, zero clocks, zero mocks.
 */

import { describe, it, expect } from "vitest";
import { createModelRoutingState, DEFAULT_MODEL_ROUTER_CONFIG } from "../state.js";
import {
  addBounded,
  computeP99,
  computeErrorRate,
  shouldFallback,
  getFastestModel,
  recordModelCallStarted,
  recordModelCallEnded,
  buildModelHealthSummary,
} from "../logic.js";

describe("oc-model-nexus / slices/model-routing (Tier 1 Unit)", () => {
  it("addBounded enforces cap and returns CheckResult proof", () => {
    const s = new Set<string>();
    expect(addBounded(s, "a", 2)).toEqual({ added: true, evicted: undefined, size: 1 });
    expect(addBounded(s, "b", 2)).toEqual({ added: true, evicted: undefined, size: 2 });
    expect(addBounded(s, "c", 2)).toEqual({ added: true, evicted: "a", size: 2 });
    expect(addBounded(s, "c", 2)).toEqual({ added: false, evicted: undefined, size: 2 });
  });

  it("computes P99, error rate, and fallback status deterministically", () => {
    expect(computeP99([])).toBe(0);
    expect(computeP99([100, 200, 300, 400, 500])).toBe(500);
    expect(computeErrorRate(0, 0)).toBe(0);
    expect(computeErrorRate(4, 1)).toBe(0.25);

    const thresh = { p99ThresholdMs: 1000, errorRateThreshold: 0.1, minSamples: 3 };
    expect(shouldFallback(5000, 0.5, thresh, 2)).toBe("healthy");
    expect(shouldFallback(1500, 0.0, thresh, 5)).toBe("degraded");
    expect(shouldFallback(1500, 0.2, thresh, 5)).toBe("critical");
  });

  it("records start/end transitions and selects fastest healthy fallback", () => {
    const state = createModelRoutingState();
    const cfg = { ...DEFAULT_MODEL_ROUTER_CONFIG, minSamples: 2, p99ThresholdMs: 500 };

    recordModelCallStarted(state, { callId: "c1", model: "slow-model" });
    recordModelCallEnded(state, cfg, { callId: "c1", model: "slow-model", durationMs: 900, success: true });
    recordModelCallEnded(state, cfg, { callId: "c2", model: "slow-model", durationMs: 950, success: false, error: "timeout" });

    recordModelCallEnded(state, cfg, { callId: "c3", model: "fast-model", durationMs: 80, success: true });
    recordModelCallEnded(state, cfg, { callId: "c4", model: "fast-model", durationMs: 90, success: true });

    expect(getFastestModel(state.modelStats, cfg)).toBe("fast-model");
    const summary = buildModelHealthSummary(state, cfg);
    expect(summary.totalModels).toBe(2);
    expect(summary.recommendedFallback).toBe("fast-model");
  });
});

