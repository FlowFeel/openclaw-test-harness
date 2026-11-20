/**
 * Tier 1 Unit Spec: oc-lane-supervisor / lane-forecaster slice.
 *
 * @dft Pure unit tests — verifies deterministic duration forecasting and telemetry formatting.
 */

import { describe, it, expect } from "vitest";
import { createLaneForecasterState } from "../state.js";
import { forecastDispatchRun } from "../logic.js";

describe("oc-lane-supervisor / slices/lane-forecaster (Tier 1 Unit)", () => {
  it("forecasts docker build command and records run start timestamp", () => {
    const state = createLaneForecasterState();
    const res = forecastDispatchRun(
      state,
      { laneCapMs: 600_000, warningThresholdRatio: 0.8 },
      {
        prompt: "Build docker image and run full integration suite",
        command: "docker build -t test .",
        sessionKey: "s1",
        nowMs: 5000,
      },
    );
    expect(state.activeRunStarts.get("s1")).toBe(5000);
    expect(res.prediction.predictedDurationMs).toBeGreaterThan(0);
    expect(res.telemetryLine.length).toBeGreaterThan(0);
  });
});

