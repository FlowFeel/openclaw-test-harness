/**
 * Unit tests for Forecaster Logic pure seam.
 *
 * @dft
 * - Pure logic: zero external fixtures, deterministic time injection.
 */

import { describe, it, expect } from "vitest";
import {
  classifyAndForecast,
  formatLaneTelemetry,
  DEFAULT_LANE_CAP_MS,
} from "../src/forecaster-logic.js";

describe("forecaster-logic (shape classification & duration prediction)", () => {
  const baseOptions = { nowMs: 1000000, laneCapMs: DEFAULT_LANE_CAP_MS };

  it("classifies work-loop sessions (diagnose -> fix -> test -> ship) as exceeding cap", () => {
    const input = {
      prompt: "Please diagnose the failure in topic 73239, implement the fix, run all test suites, and ship a PR.",
      sessionKey: "agent:main:telegram:group:-100:topic:73239",
    };

    const { prediction, report } = classifyAndForecast(input, baseOptions);

    expect(prediction.exceedsCap).toBe(true);
    expect(prediction.predictedDurationMs).toBeGreaterThanOrEqual(600000);
    expect(prediction.shape).toBe("work-loop");
    expect(prediction.matchedSignatures).toContain("work-loop");
    expect(prediction.recommendation).toBe("suggest_segmented_dispatch");
    expect(prediction.suggestedSegments?.length).toBeGreaterThanOrEqual(3);
    expect(prediction.advice).toContain("split into checkpointed segments");
    expect(report.exceedsCap).toBe(true);
    expect(report.evaluatedAt).toBe(1000000);
  });

  it("detects full test suite slow-op signature", () => {
    const input = {
      prompt: "Execute the entire regression matrix",
      command: "npm run test:ci",
    };

    const { prediction } = classifyAndForecast(input, baseOptions);
    expect(prediction.shape).toBe("test-suite");
    expect(prediction.matchedSignatures).toContain("test-suite");
    expect(prediction.predictedDurationMs).toBeGreaterThanOrEqual(240000);
  });

  it("detects probe loop slow-op signature", () => {
    const input = {
      prompt: "Wait until the endpoint responds healthy",
      command: "while true; do curl http://localhost:8080/health | grep ok && break; sleep 2; done",
    };

    const { prediction } = classifyAndForecast(input, baseOptions);
    expect(prediction.shape).toBe("probe-loop");
    expect(prediction.matchedSignatures).toContain("probe-loop");
    expect(prediction.predictedDurationMs).toBeGreaterThanOrEqual(300000);
  });

  it("detects vision/media processing slow-op signature", () => {
    const input = {
      prompt: "Process vision attachment and transcode video artifact with ffmpeg",
    };

    const { prediction } = classifyAndForecast(input, baseOptions);
    expect(prediction.shape).toBe("vision-media");
    expect(prediction.matchedSignatures).toContain("vision-media");
    expect(prediction.predictedDurationMs).toBeGreaterThanOrEqual(180000);
  });

  it("weights session duration history when prior runs encountered timeouts", () => {
    const input = {
      prompt: "Continue the ongoing investigation",
      sessionKey: "topic:56300",
      history: {
        recentDurationsMs: [590000, 600580],
        timeoutsEncountered: 1,
      },
    };

    const { prediction } = classifyAndForecast(input, baseOptions);
    expect(prediction.exceedsCap).toBe(true);
    expect(prediction.predictedDurationMs).toBeGreaterThanOrEqual(600000);
    expect(prediction.matchedSignatures).toContain("history-timeout-recurrence");
  });

  it("does not false-warning short, simple queries", () => {
    const shortInputs = [
      { prompt: "git status" },
      { prompt: "what is the current status of the service?" },
      { prompt: "show me line 10 in README.md" },
      { prompt: "check the git diff for typo fix", command: "git diff HEAD~1" },
    ];

    for (const input of shortInputs) {
      const { prediction } = classifyAndForecast(input, baseOptions);
      expect(prediction.exceedsCap).toBe(false);
      expect(prediction.recommendation).toBe("proceed_normal");
      expect(prediction.predictedDurationMs).toBeLessThan(60000);
    }
  });

  it("formats standardized lane telemetry string", () => {
    const telemetry = formatLaneTelemetry({
      laneId: "lane-main",
      topicId: 73239,
      predictedDurationMs: 680000,
      exceedsCap: true,
      shape: "work-loop",
    });

    expect(telemetry).toBe(
      "lane forecast: lane=lane-main topic:73239 predictedDurationMs=680000 exceedsCap=true shape=work-loop"
    );
  });
});
