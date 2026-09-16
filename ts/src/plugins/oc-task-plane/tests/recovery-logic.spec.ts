/**
 * Unit tests for Recovery Logic pure seam.
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic time.
 */

import { describe, it, expect } from "vitest";
import { reconcileRestartState } from "../src/recovery-logic.js";
import type { TaskPlaneRegistry, TaskPlaneTask } from "../../shared/types.js";

describe("recovery-logic (restart reconciliation and re-adoption)", () => {
  it("re-adopts alive processes and finalizes dead processes on restart", () => {
    const registry: TaskPlaneRegistry = {
      version: 10,
      tasks: {
        "task-alive": {
          id: "task-alive",
          kind: "exec",
          payload: { command: "long-task" },
          owner: "session-1",
          timeoutMs: 600000,
          status: "running",
          output_handle: "/tmp/out-alive.log",
          timestamps: { queuedAt: 1000, startedAt: 1100 },
          pid: 5001,
        },
        "task-dead": {
          id: "task-dead",
          kind: "exec",
          payload: { command: "crashed-task" },
          owner: "session-2",
          timeoutMs: 600000,
          status: "running",
          output_handle: "/tmp/out-dead.log",
          timestamps: { queuedAt: 1000, startedAt: 1100 },
          pid: 5002,
        },
        "task-already-done": {
          id: "task-already-done",
          kind: "exec",
          payload: {},
          owner: "session-3",
          timeoutMs: 600000,
          status: "done",
          output_handle: "/tmp/out-done.log",
          timestamps: { queuedAt: 1000, startedAt: 1100, completedAt: 1500 },
        },
      },
    };

    // System snapshot: only PID 5001 survived
    const activePids = [5001, 1, 42];

    const { registry: nextReg, readoptedTasks, deadTasks, wakes, report } =
      reconcileRestartState(registry, activePids, { nowMs: 5000 });

    // 1. Task with alive PID is re-adopted
    expect(readoptedTasks.length).toBe(1);
    expect(readoptedTasks[0].id).toBe("task-alive");
    expect(nextReg.tasks["task-alive"].readopted).toBe(true);
    expect(nextReg.tasks["task-alive"].status).toBe("running");

    // 2. Task with dead PID is finalized
    expect(deadTasks.length).toBe(1);
    expect(deadTasks[0].id).toBe("task-dead");
    expect(nextReg.tasks["task-dead"].status).toBe("failed");
    expect(nextReg.tasks["task-dead"].result?.error).toContain("Process 5002 terminated while gateway was down");
    expect(nextReg.tasks["task-dead"].timestamps.completedAt).toBe(5000);

    // 3. Wakes delivered for both
    expect(wakes.length).toBe(2);
    const readoptWake = wakes.find((w) => w.taskId === "task-alive");
    expect(readoptWake?.event).toBe("task_readopted");
    expect(readoptWake?.targetSessionKey).toBe("session-1");

    const deadWake = wakes.find((w) => w.taskId === "task-dead");
    expect(deadWake?.event).toBe("task_complete");
    expect(deadWake?.targetSessionKey).toBe("session-2");

    // 4. Report verification
    expect(report.readoptedCount).toBe(1);
    expect(report.finalizedDeadCount).toBe(1);
    expect(report.runningTasksFound).toBe(2);
  });
});
