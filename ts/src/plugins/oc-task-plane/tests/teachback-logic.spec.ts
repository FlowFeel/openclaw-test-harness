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

    expect(teachback.summary).toBe(
      "Killed at 630s lane cap. Partial output preserved at handle /tmp/openclaw-tasks/task-test-1.log. Re-dispatch with task_dispatch to resume."
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
});
