/**
 * Unit tests for TeachBack Logic pure seam.
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic time.
 */

import { describe, it, expect } from "vitest";
import { formatPostKillTeachback } from "../src/teachback-logic.js";
import type { TaskPlaneTask } from "../../shared/types.js";

describe("teachback-logic (diagnostics formatting)", () => {
  it("formats a teach-back message for a task killed at the lane cap", () => {
    const task: TaskPlaneTask = {
      id: "task-test-1",
      kind: "exec",
      payload: { command: "docker build -t test ." },
      owner: "session-xyz",
      timeoutMs: 630000,
      status: "killed",
      output_handle: "/tmp/openclaw-tasks/task-test-1.log",
      timestamps: { queuedAt: 1000, startedAt: 1000, completedAt: 631000 },
      result: {
        error: "Killed at 630s lane cap",
        outputTail: "Step 4/10: Running npm install...",
      },
    };

    const { teachback, report } = formatPostKillTeachback(task, { nowMs: 632000 });

    expect(teachback.summary).toContain("Killed at 630s lane cap");
    expect(teachback.summary).toContain("Note: this is a lane timeout, not an LLM provider outage.");
    expect(teachback.summary).toContain(
      "Partial output preserved at handle /tmp/openclaw-tasks/task-test-1.log. Re-dispatch with task_dispatch to resume."
    );
    expect(teachback.outputHandle).toBe("/tmp/openclaw-tasks/task-test-1.log");
    expect(teachback.detail).toContain("Step 4/10: Running npm install...");
    expect(teachback.suggestedAction).toContain("task_dispatch");
    expect(teachback.suggestedAction).toContain("task_output");
    expect(teachback.resumeCommandHint).toBe(
      'task_dispatch({ command: "docker build -t test ." }, 1260000)'
    );
    expect(report.taskId).toBe("task-test-1");
  });

  it("handles tasks without commands or output tails gracefully", () => {
    const task: TaskPlaneTask = {
      id: "task-generic",
      kind: "subagent",
      payload: {},
      owner: "session-xyz",
      timeoutMs: 300000,
      status: "killed",
      output_handle: "/tmp/output.log",
      timestamps: { queuedAt: 1000, startedAt: 1000, completedAt: 301000 },
    };

    const { teachback } = formatPostKillTeachback(task, { nowMs: 302000 });
    expect(teachback.summary).toContain("Killed at 300s lane cap");
    expect(teachback.resumeCommandHint).toBeUndefined();
  });

  it("incorporates observable shipped-state with pushed commits and PR", () => {
    const task: TaskPlaneTask = {
      id: "task-work-loop",
      kind: "exec",
      payload: { command: "git push origin feat/lane-cap" },
      owner: "topic:73239",
      timeoutMs: 600000,
      status: "killed",
      output_handle: "/tmp/output/task-work-loop.log",
      timestamps: { queuedAt: 1000, startedAt: 1000, completedAt: 601000 },
      result: {
        error: "Killed at 600s lane cap",
      },
    };

    const shippedState = {
      lastCommitSha: "a1b2c3d4e5f6",
      lastCommitMessage: "feat(lane): checkpoint early before cap",
      lastPushedBranch: "feat/lane-cap",
      lastPrNumber: 365,
      hasUncommittedChanges: false,
      shippedAt: 590000,
      status: "shipped_clean" as const,
    };

    const { teachback, report } = formatPostKillTeachback(task, {
      nowMs: 601000,
      capMs: 600000,
      durationMs: 600580,
      shippedState,
    });

    expect(teachback.durationMs).toBe(600580);
    expect(teachback.capMs).toBe(600000);
    expect(teachback.summary).toContain("Killed at 600s lane cap (601s elapsed)");
    expect(teachback.summary).toContain("Note: this is a lane timeout, not an LLM provider outage.");
    expect(teachback.detail).toContain("Observable shipped-state: commit a1b2c3d on branch 'feat/lane-cap' (PR #365).");
    expect(teachback.detail).toContain("Work survived by policy — resume checkpoint from this commit.");
    expect(report.shippedStateStatus).toBe("shipped_clean");
    expect(report.durationMs).toBe(600580);
  });

  it("warns about uncommitted working tree changes in teach-back", () => {
    const task: TaskPlaneTask = {
      id: "task-dirty",
      kind: "exec",
      payload: {},
      owner: "topic:56300",
      timeoutMs: 600000,
      status: "killed",
      output_handle: "/tmp/output/task-dirty.log",
      timestamps: { queuedAt: 1000, startedAt: 1000, completedAt: 600694 },
    };

    const { teachback, report } = formatPostKillTeachback(task, {
      nowMs: 601000,
      durationMs: 600694,
      shippedState: {
        hasUncommittedChanges: true,
        status: "uncommitted_changes" as const,
      },
    });

    expect(teachback.detail).toContain("working tree contains uncommitted changes");
    expect(report.shippedStateStatus).toBe("uncommitted_changes");
  });
});
