/**
 * Tier 1 Unit Spec: oc-task-plane / task-dispatch slice.
 *
 * @dft Pure unit tests — zero filesystem/process I/O, zero clocks.
 */

import { describe, it, expect } from "vitest";
import { createTaskDispatchState } from "../state.js";
import {
  dispatchNewTask,
  transitionTaskComplete,
  transitionTaskCancel,
  queryTaskStatus,
  stepTimeoutSupervisor,
} from "../logic.js";

describe("oc-task-plane / slices/task-dispatch (Tier 1 Unit)", () => {
  const cfg = {
    registryPath: "/mem/tasks.json",
    outputDir: "/mem/out",
    defaultTimeoutMs: 10_000,
    supervisorIntervalMs: 1000,
  };

  it("dispatches, queries, completes, cancels, and times out tasks deterministically", () => {
    let state = createTaskDispatchState();
    const d1 = dispatchNewTask(state, cfg, {
      command: "echo hi",
      kind: "exec",
      owner: "s1",
      nowMs: 1000,
    });
    state = d1.nextState;
    expect(d1.task.status).toBe("running");

    const q = queryTaskStatus(state, d1.task.id);
    expect(q.tasks).toHaveLength(1);

    const done = transitionTaskComplete(state, d1.task.id, 0, 2000);
    state = done.nextState;
    expect(state.registry.tasks[d1.task.id].status).toBe("done");

    const d2 = dispatchNewTask(state, cfg, {
      command: "sleep 999",
      kind: "exec",
      owner: "s1",
      timeoutMs: 5000,
      nowMs: 3000,
    });
    state = d2.nextState;

    const to = stepTimeoutSupervisor(state, 9000);
    state = to.nextState;
    expect(to.timedOutTasks.map((t) => t.id)).toContain(d2.task.id);

    const d3 = dispatchNewTask(state, cfg, {
      command: "long-job",
      kind: "durable",
      owner: "s1",
      nowMs: 10_000,
    });
    state = d3.nextState;
    const cancelled = transitionTaskCancel(state, d3.task.id, "stop", 11_000);
    expect(cancelled.task?.status).toBe("killed");
  });
});

