/**
 * Unit tests for exec_pipeline pure logic seam (T-583).
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic.
 * - Covers spec validation, conditional decisions, and run summarization.
 */

import { describe, it, expect } from "vitest";
import {
  validatePipelineSpec,
  decideStepExecution,
  summarizePipelineRun,
  type PipelineStepResult,
} from "../src/exec-pipeline-logic.js";

describe("validatePipelineSpec", () => {
  it("accepts a minimal spec and applies defaults", () => {
    const res = validatePipelineSpec({ steps: [{ command: "echo hi" }] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spec.mode).toBe("sequential");
      expect(res.spec.stopOnFailure).toBe(true);
      expect(res.spec.steps).toEqual([{ command: "echo hi", condition: "always" }]);
    }
  });

  it("accepts a full spec with piped mode and mixed conditions", () => {
    const res = validatePipelineSpec({
      steps: [
        { command: "cat in.txt", condition: "always" },
        { command: "grep foo", condition: "on_success" },
        { command: "echo fallback", condition: "on_failure" },
      ],
      mode: "piped",
      stopOnFailure: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spec.mode).toBe("piped");
      expect(res.spec.stopOnFailure).toBe(false);
      expect(res.spec.steps.map((s) => s.condition)).toEqual([
        "always",
        "on_success",
        "on_failure",
      ]);
    }
  });

  it("rejects a missing or empty steps array", () => {
    expect(validatePipelineSpec(null).ok).toBe(false);
    expect(validatePipelineSpec({}).ok).toBe(false);
    expect(validatePipelineSpec({ steps: [] }).ok).toBe(false);
    expect(validatePipelineSpec({ steps: "nope" }).ok).toBe(false);
  });

  it("rejects non-object steps and empty commands", () => {
    expect(validatePipelineSpec({ steps: ["echo hi"] }).ok).toBe(false);
    expect(validatePipelineSpec({ steps: [{ command: "" }] }).ok).toBe(false);
    expect(validatePipelineSpec({ steps: [{ command: "   " }] }).ok).toBe(false);
    expect(validatePipelineSpec({ steps: [{ }] }).ok).toBe(false);
  });

  it("rejects invalid mode, condition, and stopOnFailure with precise messages", () => {
    const badMode = validatePipelineSpec({ steps: [{ command: "x" }], mode: "parallel" });
    expect(badMode.ok).toBe(false);
    if (!badMode.ok) expect(badMode.error).toContain("invalid mode 'parallel'");

    const badCond = validatePipelineSpec({ steps: [{ command: "x", condition: "sometimes" }] });
    expect(badCond.ok).toBe(false);
    if (!badCond.ok) expect(badCond.error).toContain("step 0 has invalid condition 'sometimes'");

    const badStop = validatePipelineSpec({ steps: [{ command: "x" }], stopOnFailure: "yes" });
    expect(badStop.ok).toBe(false);
    if (!badStop.ok) expect(badStop.error).toContain("stopOnFailure must be a boolean");
  });
});

describe("decideStepExecution", () => {
  const okPrev = { exitCode: 0 };
  const failPrev = { exitCode: 1 };

  it("always runs regardless of previous outcome", () => {
    expect(decideStepExecution("always", null).run).toBe(true);
    expect(decideStepExecution("always", failPrev).run).toBe(true);
  });

  it("first step runs unconditionally for on_success and on_failure", () => {
    expect(decideStepExecution("on_success", null).run).toBe(true);
    expect(decideStepExecution("on_failure", null).run).toBe(true);
  });

  it("on_success mirrors && semantics", () => {
    expect(decideStepExecution("on_success", okPrev).run).toBe(true);
    expect(decideStepExecution("on_success", failPrev).run).toBe(false);
  });

  it("on_failure mirrors || semantics", () => {
    expect(decideStepExecution("on_failure", failPrev).run).toBe(true);
    expect(decideStepExecution("on_failure", okPrev).run).toBe(false);
  });

  it("treats spawn errors and null exit codes as failure", () => {
    expect(decideStepExecution("on_success", { exitCode: null }).run).toBe(false);
    expect(decideStepExecution("on_success", { exitCode: 0, error: "spawn boom" }).run).toBe(false);
    expect(decideStepExecution("on_failure", { exitCode: 0, error: "spawn boom" }).run).toBe(true);
  });

  it("returns a reason string for skipped steps", () => {
    const d = decideStepExecution("on_success", failPrev);
    expect(d.run).toBe(false);
    expect(d.reason).toContain("previous step failed");
  });
});

describe("summarizePipelineRun", () => {
  const spec = validatePipelineSpec({
    steps: [{ command: "a" }, { command: "b" }, { command: "c", condition: "on_success" }],
  });
  if (!spec.ok) throw new Error("spec must validate");

  it("summarizes a fully successful run", () => {
    const results: PipelineStepResult[] = [
      { index: 0, command: "a", executed: true, exitCode: 0 },
      { index: 1, command: "b", executed: true, exitCode: 0 },
      { index: 2, command: "c", executed: true, exitCode: 0 },
    ];
    const report = summarizePipelineRun(spec.spec, results);
    expect(report.ok).toBe(true);
    expect(report.executedCount).toBe(3);
    expect(report.skippedCount).toBe(0);
    expect(report.failedStepIndex).toBeNull();
    expect(report.finalExitCode).toBe(0);
    expect(report.steps).toHaveLength(3);
  });

  it("reports the first failed step and carries finalExitCode", () => {
    const results: PipelineStepResult[] = [
      { index: 0, command: "a", executed: true, exitCode: 0 },
      { index: 1, command: "b", executed: true, exitCode: 3 },
      { index: 2, command: "c", executed: false, skipped: true, skipReason: "x" },
    ];
    const report = summarizePipelineRun(spec.spec, results);
    expect(report.ok).toBe(false);
    expect(report.failedStepIndex).toBe(1);
    expect(report.executedCount).toBe(2);
    expect(report.skippedCount).toBe(1);
    expect(report.finalExitCode).toBe(3);
  });

  it("treats timeouts and spawn errors as failures", () => {
    const results: PipelineStepResult[] = [
      { index: 0, command: "a", executed: true, exitCode: null, timedOut: true },
    ];
    const report = summarizePipelineRun(spec.spec, results);
    expect(report.ok).toBe(false);
    expect(report.failedStepIndex).toBe(0);
  });

  it("is ok when a stopOnFailure abort leaves later steps skipped", () => {
    const results: PipelineStepResult[] = [
      { index: 0, command: "a", executed: true, exitCode: 0 },
      { index: 1, command: "b", executed: true, exitCode: 2 },
      { index: 2, command: "c", executed: false, skipped: true, skipReason: "stopOnFailure" },
    ];
    const report = summarizePipelineRun(spec.spec, results);
    expect(report.ok).toBe(false);
    expect(report.skippedCount).toBe(1);
  });
});
