/**
 * Telemetry logic tests — pure functions, no perf_hooks.
 *
 * @dft
 * - All functions are pure (input → output)
 * - No I/O, no Date.now(), no Math.random()
 * - Tests run in <1ms
 */

import { describe, it, expect } from "vitest";
import {
  aggregateSystemHealth,
  type ProcessTelemetry,
} from "../../../src/plugins/oc-sidecar/src/telemetry-logic.js";

const HEALTHY: ProcessTelemetry = {
  actorId: "main",
  eventLoopP99Ms: 10,
  eventLoopUtilization: 0.1,
  usedHeapSize: 50 * 1024 * 1024, // 50MB
  cpuRatio: 0.05,
};

const DEGRADED: ProcessTelemetry = {
  actorId: "main",
  eventLoopP99Ms: 100,
  eventLoopUtilization: 0.5,
  usedHeapSize: 200 * 1024 * 1024,
  cpuRatio: 0.3,
};

const CRITICAL: ProcessTelemetry = {
  actorId: "main",
  eventLoopP99Ms: 500,
  eventLoopUtilization: 0.8,
  usedHeapSize: 600 * 1024 * 1024, // >500MB
  cpuRatio: 0.9,
};

describe("aggregateSystemHealth", () => {
  it("returns healthy for low metrics", () => {
    const result = aggregateSystemHealth([HEALTHY], 0, 0);
    expect(result.status).toBe("healthy");
    expect(result.eventLoopP99Ms).toBe(10);
    expect(result.activeSubagents).toBe(0);
  });

  it("returns degraded for moderate metrics", () => {
    const result = aggregateSystemHealth([DEGRADED], 2, 0);
    expect(result.status).toBe("degraded");
    expect(result.eventLoopP99Ms).toBe(100);
    expect(result.activeSubagents).toBe(2);
  });

  it("returns critical for high event loop delay", () => {
    const result = aggregateSystemHealth([CRITICAL], 4, 2);
    expect(result.status).toBe("critical");
    expect(result.staleSubagents).toBe(2);
  });

  it("returns critical for high utilization even with low P99", () => {
    const reading: ProcessTelemetry = {
      ...HEALTHY,
      eventLoopUtilization: 0.8,
    };
    const result = aggregateSystemHealth([reading], 0, 0);
    expect(result.status).toBe("critical");
  });

  it("returns critical for heap over 500MB", () => {
    const reading: ProcessTelemetry = {
      ...HEALTHY,
      usedHeapSize: 600 * 1024 * 1024,
    };
    const result = aggregateSystemHealth([reading], 0, 0);
    expect(result.status).toBe("critical");
  });

  it("takes max across multiple readings (worst case)", () => {
    const result = aggregateSystemHealth([HEALTHY, DEGRADED], 1, 0);
    expect(result.eventLoopP99Ms).toBe(100); // max
    expect(result.eventLoopUtilization).toBe(0.5); // max
    expect(result.status).toBe("degraded");
  });

  it("averages CPU across readings", () => {
    const result = aggregateSystemHealth([HEALTHY, CRITICAL], 0, 0);
    const avgCpu = (0.05 + 0.9) / 2;
    expect(result.cpuRatio).toBeCloseTo(avgCpu, 5);
  });

  it("handles empty readings", () => {
    const result = aggregateSystemHealth([], 0, 0);
    expect(result.status).toBe("healthy");
    expect(result.readings).toBe(0);
    expect(result.eventLoopP99Ms).toBe(0);
  });

  it("reports reading count", () => {
    const result = aggregateSystemHealth([HEALTHY, DEGRADED, CRITICAL], 3, 1);
    expect(result.readings).toBe(3);
  });
});
