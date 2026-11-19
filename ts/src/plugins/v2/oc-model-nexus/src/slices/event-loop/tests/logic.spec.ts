/**
 * Tier 1 Unit Spec: oc-model-nexus / event-loop slice.
 *
 * @dft Pure unit tests — zero perf_hooks/v8 I/O, deterministic telemetry readings.
 */

import { describe, it, expect } from "vitest";
import { createEventLoopState } from "../state.js";
import { recordTelemetryReading, evaluateEventLoopHealth } from "../logic.js";
import type { ProcessTelemetry } from "../../../../../../shared/telemetry-logic.js";

function sampleReading(p99Ms: number): ProcessTelemetry {
  return {
    actorId: "main",
    eventLoopP99Ms: p99Ms,
    eventLoopUtilization: 0.2,
    usedHeapSize: 120 * 1024 * 1024,
    cpuRatio: 0.15,
  };
}

describe("oc-model-nexus / slices/event-loop (Tier 1 Unit)", () => {
  it("enforces bounded window and aggregates system health deterministically", () => {
    let state = createEventLoopState(2);
    const r1 = recordTelemetryReading(state, sampleReading(10));
    state = r1.nextState;
    expect(r1.trimmed).toBe(false);

    const r2 = recordTelemetryReading(state, sampleReading(15));
    state = r2.nextState;
    const r3 = recordTelemetryReading(state, sampleReading(20));
    state = r3.nextState;

    expect(r3.trimmed).toBe(true);
    expect(state.readings).toHaveLength(2);
    const health = evaluateEventLoopHealth(state, 10);
    expect(health.status).toBe("healthy");
  });
});
