/**
 * OC Model Router pure-logic specs.
 *
 * @dft
 * - DETERMINISTIC: all pure functions (computeP99, computeErrorRate,
 *   shouldFallback, getFastestModel) are tested with inline data.
 * - No I/O — no file system, no network, no hook dispatch.
 * - No mutation — computeP99 does not sort the input array.
 */
import { describe, it, expect } from "vitest";
import {
  computeP99,
  computeErrorRate,
  shouldFallback,
  getFastestModel,
  type ModelStatsMap,
  type ModelStats,
} from "../../../src/plugins/oc-model-router/src/index.js";

const THRESHOLDS = {
  p99ThresholdMs: 15_000,
  errorRateThreshold: 0.1,
  minSamples: 5,
};

// ── computeP99 ────────────────────────────────────────────────

describe("computeP99", () => {
  it("returns 0 for an empty array", () => {
    expect(computeP99([])).toBe(0);
  });

  it("returns the single value for a one-element array", () => {
    expect(computeP99([42])).toBe(42);
  });

  it("returns the 99th percentile for 100 values", () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // idx = ceil(100 * 0.99) - 1 = 99 - 1 = 98 → sorted[98] = 99
    expect(computeP99(latencies)).toBe(99);
  });

  it("returns the 99th percentile for 1000 values", () => {
    const latencies = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
    // idx = ceil(1000 * 0.99) - 1 = 990 - 1 = 989 → sorted[989] = 990
    expect(computeP99(latencies)).toBe(990);
  });

  it("handles an unsorted input array", () => {
    expect(computeP99([100, 1, 50, 25, 75])).toBe(100);
  });

  it("does not mutate the input array", () => {
    const input = [100, 1, 50, 25, 75];
    const snapshot = [...input];
    computeP99(input);
    expect(input).toEqual(snapshot);
  });

  it("returns the max value for a small array (ceil(n*0.99)-1 clamped to 0)", () => {
    // For 5 elements: idx = ceil(5 * 0.99) - 1 = 5 - 1 = 4 → sorted[4] = max
    expect(computeP99([10, 20, 30, 40, 50])).toBe(50);
  });
});

// ── computeErrorRate ──────────────────────────────────────────

describe("computeErrorRate", () => {
  it("returns 0 when total is 0", () => {
    expect(computeErrorRate(0, 0)).toBe(0);
  });

  it("returns 0 when total is negative", () => {
    expect(computeErrorRate(-1, 0)).toBe(0);
  });

  it("computes errors / total", () => {
    expect(computeErrorRate(100, 10)).toBe(0.1);
    expect(computeErrorRate(4, 1)).toBe(0.25);
    expect(computeErrorRate(10, 0)).toBe(0);
  });

  it("returns 1 when all calls are errors", () => {
    expect(computeErrorRate(5, 5)).toBe(1);
  });
});

// ── shouldFallback ────────────────────────────────────────────

describe("shouldFallback", () => {
  it("returns 'healthy' when below minSamples", () => {
    // Even if P99 and error rate are terrible, not enough data
    const result = shouldFallback(100_000, 0.9, THRESHOLDS, 3);
    expect(result).toBe("healthy");
  });

  it("returns 'healthy' when P99 and error rate are both good", () => {
    const result = shouldFallback(1000, 0.01, THRESHOLDS, 10);
    expect(result).toBe("healthy");
  });

  it("returns 'degraded' when only P99 is above threshold", () => {
    const result = shouldFallback(20_000, 0.01, THRESHOLDS, 10);
    expect(result).toBe("degraded");
  });

  it("returns 'degraded' when only error rate is above threshold (but below 3x)", () => {
    // 0.2 > 0.1 (threshold) but < 0.3 (3x threshold) → degraded, not critical
    const result = shouldFallback(1000, 0.2, THRESHOLDS, 10);
    expect(result).toBe("degraded");
  });

  it("returns 'critical' when both P99 and error rate are above thresholds", () => {
    const result = shouldFallback(20_000, 0.5, THRESHOLDS, 10);
    expect(result).toBe("critical");
  });

  it("returns 'critical' when P99 is 3x the threshold", () => {
    // 3x of 15000 = 45000
    const result = shouldFallback(45_001, 0.01, THRESHOLDS, 10);
    expect(result).toBe("critical");
  });

  it("returns 'critical' when error rate is 3x the threshold", () => {
    // 3x of 0.1 = 0.3
    const result = shouldFallback(1000, 0.31, THRESHOLDS, 10);
    expect(result).toBe("critical");
  });

  it("returns 'healthy' at exactly minSamples when metrics are good", () => {
    const result = shouldFallback(1000, 0.01, THRESHOLDS, 5);
    expect(result).toBe("healthy");
  });

  it("returns 'degraded' at exactly minSamples when P99 is bad", () => {
    const result = shouldFallback(20_000, 0.01, THRESHOLDS, 5);
    expect(result).toBe("degraded");
  });
});

// ── getFastestModel ───────────────────────────────────────────

describe("getFastestModel", () => {
  it("returns null for an empty map", () => {
    expect(getFastestModel(new Map())).toBeNull();
  });

  it("returns null when all models have empty latencies", () => {
    const stats: ModelStatsMap = new Map([
      ["model-a", { latencies: [], errors: 0, total: 0 }],
      ["model-b", { latencies: [], errors: 0, total: 0 }],
    ]);
    expect(getFastestModel(stats)).toBeNull();
  });

  it("returns the single model when only one has latencies", () => {
    const stats: ModelStatsMap = new Map([
      ["model-a", { latencies: [100, 200], errors: 0, total: 2 }],
      ["model-b", { latencies: [], errors: 0, total: 0 }],
    ]);
    expect(getFastestModel(stats)).toBe("model-a");
  });

  it("returns the model with the lowest average latency", () => {
    const stats: ModelStatsMap = new Map([
      ["slow", { latencies: [500, 600, 700], errors: 0, total: 3 }], // avg 600
      ["fast", { latencies: [100, 200, 300], errors: 0, total: 3 }], // avg 200
      ["medium", { latencies: [300, 400, 500], errors: 0, total: 3 }], // avg 400
    ]);
    expect(getFastestModel(stats)).toBe("fast");
  });

  it("handles a single model", () => {
    const stats: ModelStatsMap = new Map([
      ["only", { latencies: [100, 200], errors: 0, total: 2 }],
    ]);
    expect(getFastestModel(stats)).toBe("only");
  });

  it("does not mutate the input map", () => {
    const stats: ModelStatsMap = new Map([
      ["model-a", { latencies: [100], errors: 0, total: 1 }],
    ]);
    const snapshot = new Map(stats);
    getFastestModel(stats);
    expect(stats).toEqual(snapshot);
  });
});
