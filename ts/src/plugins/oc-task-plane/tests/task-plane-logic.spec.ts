/**
 * Unit tests for TaskPlane logic seam.
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic time.
 */

import { describe, it, expect } from "vitest";
import {
  createRegistry,
  dispatchTask,
  startTask,
  completeTask,
  failTask,
  killTask,
  evaluateTimeouts,
  filterTasks,
  generateCompletionWake,
} from "../src/task-plane-logic.js";

describe("task-plane-logic (pure state machine)", () => {
  it("initializes an empty registry with version 1", () => {
    const reg = createRegistry();
    expect(reg.tasks).toEqual({});
    expect(reg.version).toBe(1);
  });

  it("dispatches task in queued status with non-blocking immutability", () => {
    const reg0 = createRegistry();
    const { registry: reg1, task, report } = dispatchTask(
      reg0,
      {
        id: "task-1",
        kind: "exec",
        payload: { command: "echo hello" },
        owner: "session-abc",
        timeoutMs: 30000,
        output_handle: "output://task-1",
      },
      { nowMs: 1000 }
    );

    expect(reg1.version).toBe(2);
    expect(task.id).toBe("task-1");
    expect(task.status).toBe("queued");
    expect(task.timeoutMs).toBe(30000);
    expect(task.timestamps.queuedAt).toBe(1000);
    expect(report.action).toBe("dispatch");
    // Immutability check
    expect(reg0.tasks["task-1"]).toBeUndefined();
  });

  it("starts a queued task with running status and PID", () => {
    const reg0 = createRegistry();
    const { registry: reg1 } = dispatchTask(
      reg0,
      { id: "task-1", payload: {}, owner: "session-1" },
      { nowMs: 1000 }
    );

    const { registry: reg2, task, report } = startTask(
      reg1,
      "task-1",
      { nowMs: 1500, pid: 12345 }
    );

    expect(task?.status).toBe("running");
    expect(task?.pid).toBe(12345);
    expect(task?.timestamps.startedAt).toBe(1500);
    expect(report.action).toBe("start");
    expect(reg2.tasks["task-1"].status).toBe("running");
  });

  it("completes a task and generates a single wake event (push, not poll)", () => {
    const reg0 = createRegistry();
    const { registry: reg1 } = dispatchTask(
      reg0,
      { id: "task-1", payload: {}, owner: "session-1", output_handle: "/tmp/t1.log" },
      { nowMs: 1000 }
    );
    const { registry: reg2 } = startTask(reg1, "task-1", { nowMs: 1200 });

    const { registry: reg3, task, wake, report } = completeTask(
      reg2,
      "task-1",
      { exitCode: 0, outputTail: "Done successfully." },
      { nowMs: 2000 }
    );

    expect(task?.status).toBe("done");
    expect(task?.timestamps.completedAt).toBe(2000);
    expect(task?.result?.exitCode).toBe(0);
    expect(wake).toEqual({
      targetSessionKey: "session-1",
      event: "task_complete",
      taskId: "task-1",
      kind: "exec",
      status: "done",
      output_handle: "/tmp/t1.log",
      result: { exitCode: 0, outputTail: "Done successfully." },
    });
    expect(report.statusAfter).toBe("done");
    expect(reg3.tasks["task-1"].status).toBe("done");
  });

  it("fails a task on non-zero exit code or error and delivers completion wake", () => {
    const reg0 = createRegistry();
    const { registry: reg1 } = dispatchTask(
      reg0,
      { id: "task-fail", payload: {}, owner: "session-1" },
      { nowMs: 1000 }
    );

    const { registry: reg2, task, wake } = failTask(
      reg1,
      "task-fail",
      "Process exited with code 1",
      { nowMs: 2500, exitCode: 1, outputTail: "Error: syntax error" }
    );

    expect(task?.status).toBe("failed");
    expect(task?.result?.error).toBe("Process exited with code 1");
    expect(task?.result?.exitCode).toBe(1);
    expect(wake?.status).toBe("failed");
    expect(reg2.tasks["task-fail"].status).toBe("failed");
  });

  it("kills a task and preserves reason and output tail", () => {
    const reg0 = createRegistry();
    const { registry: reg1 } = dispatchTask(
      reg0,
      { id: "task-kill", payload: {}, owner: "session-1" },
      { nowMs: 1000 }
    );
    const { registry: reg2 } = startTask(reg1, "task-kill", { nowMs: 1100 });

    const { registry: reg3, task, wake } = killTask(
      reg2,
      "task-kill",
      "User canceled",
      { nowMs: 1800, outputTail: "partial log line" }
    );

    expect(task?.status).toBe("killed");
    expect(task?.result?.error).toBe("User canceled");
    expect(task?.result?.outputTail).toBe("partial log line");
    expect(wake?.status).toBe("killed");
    expect(reg3.tasks["task-kill"].status).toBe("killed");
  });

  it("evaluates timeouts according to Invariant 4 (supervisor enforcement)", () => {
    const reg0 = createRegistry();
    // Task 1: 5000ms timeout, started at 1000ms
    const { registry: reg1 } = dispatchTask(
      reg0,
      { id: "t1", payload: {}, owner: "s1", timeoutMs: 5000 },
      { nowMs: 1000 }
    );
    const { registry: reg2 } = startTask(reg1, "t1", { nowMs: 1000 });

    // Task 2: 10000ms timeout, started at 2000ms
    const { registry: reg3 } = dispatchTask(
      reg2,
      { id: "t2", payload: {}, owner: "s2", timeoutMs: 10000 },
      { nowMs: 2000 }
    );
    const { registry: reg4 } = startTask(reg3, "t2", { nowMs: 2000 });

    // At nowMs = 6000: t1 has run for 5000ms (>= 5000ms timeout) -> timed out!
    // t2 has run for 4000ms (< 10000ms) -> still running
    const { registry: reg5, timedOutTasks, wakes } = evaluateTimeouts(reg4, { nowMs: 6000 });

    expect(timedOutTasks.length).toBe(1);
    expect(timedOutTasks[0].id).toBe("t1");
    expect(timedOutTasks[0].status).toBe("killed");
    expect(timedOutTasks[0].result?.error).toContain("Timeout exceeded: ran for 5000ms (cap: 5000ms)");
    expect(wakes.length).toBe(1);
    expect(wakes[0].taskId).toBe("t1");

    expect(reg5.tasks["t1"].status).toBe("killed");
    expect(reg5.tasks["t2"].status).toBe("running");
  });

  it("filters tasks by owner and status", () => {
    let reg = createRegistry();
    reg = dispatchTask(reg, { id: "t1", payload: {}, owner: "owner-a" }, { nowMs: 1 }).registry;
    reg = dispatchTask(reg, { id: "t2", payload: {}, owner: "owner-b" }, { nowMs: 2 }).registry;
    reg = dispatchTask(reg, { id: "t3", payload: {}, owner: "owner-a" }, { nowMs: 3 }).registry;
    reg = startTask(reg, "t3", { nowMs: 4 }).registry;

    const all = filterTasks(reg);
    expect(all.length).toBe(3);

    const ownerA = filterTasks(reg, { owner: "owner-a" });
    expect(ownerA.length).toBe(2);

    const queuedA = filterTasks(reg, { owner: "owner-a", status: "queued" });
    expect(queuedA.length).toBe(1);
    expect(queuedA[0].id).toBe("t1");
  });
});
