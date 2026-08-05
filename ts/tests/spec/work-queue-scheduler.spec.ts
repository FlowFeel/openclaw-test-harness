/**
 * Work Queue Scheduler pure-logic specs.
 *
 * @dft
 * - DETERMINISTIC: all functions are pure (input state → output state).
 * - No Date.now() — uses injected timestamps.
 * - No I/O — no file system, no network, no real spawning.
 * - State is immutable (each operation returns new state).
 */
import { describe, it, expect } from "vitest";
import {
  createQueue,
  dispatchNext,
  recordResult,
  failBlockedTasks,
  getResultsInOrder,
  computeProgress,
  isComplete,
  computeEffectiveMaxConcurrent,
  type TaskSpec,
  type WorkQueueState,
} from "../../src/plugins/shared/work-queue-scheduler.js";

const NOW = 1_000_000;

function spec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { id, prompt: `prompt-${id}`, ...overrides };
}

// ── createQueue ───────────────────────────────────────────────

describe("createQueue", () => {
  it("creates a queue with all tasks in 'queued' status", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    expect(q.tasks.size).toBe(2);
    expect(q.tasks.get("t1")?.status).toBe("queued");
    expect(q.tasks.get("t2")?.status).toBe("queued");
  });

  // NOTE: createQueue builds a priority-sorted `order` array internally but
  // does NOT return it — the tasks Map preserves insertion order (spec order).
  // Priority sorting is dead code. These tests document the actual behavior.
  it("preserves insertion order in the tasks Map (not priority order)", () => {
    const q = createQueue([
      spec("normal"),
      spec("high", { priority: "high" }),
      spec("low", { priority: "low" }),
    ]);
    const ids = Array.from(q.tasks.keys());
    expect(ids).toEqual(["normal", "high", "low"]); // insertion order, not priority
  });

  it("preserves spec order regardless of priority", () => {
    const q = createQueue([
      spec("low", { priority: "low" }),
      spec("normal"),
      spec("high", { priority: "high" }),
    ]);
    const ids = Array.from(q.tasks.keys());
    expect(ids).toEqual(["low", "normal", "high"]); // insertion order preserved
  });

  it("handles an empty spec list", () => {
    const q = createQueue([]);
    expect(q.tasks.size).toBe(0);
  });

  it("initializes dispatch and completion order as empty", () => {
    const q = createQueue([spec("t1")]);
    expect(q.dispatchOrder).toEqual([]);
    expect(q.completionOrder).toEqual([]);
  });
});

// ── dispatchNext ──────────────────────────────────────────────

describe("dispatchNext", () => {
  it("dispatches queued tasks up to maxConcurrent", () => {
    const q = createQueue([spec("t1"), spec("t2"), spec("t3")]);
    const { taskIds, state } = dispatchNext(q, 2, NOW);
    expect(taskIds).toHaveLength(2);
    expect(state.tasks.get("t1")?.status).toBe("dispatched");
    expect(state.tasks.get("t2")?.status).toBe("dispatched");
    expect(state.tasks.get("t3")?.status).toBe("queued");
  });

  it("marks dispatched tasks with a timestamp", () => {
    const q = createQueue([spec("t1")]);
    const { state } = dispatchNext(q, 1, NOW);
    expect(state.tasks.get("t1")?.dispatchedAtMs).toBe(NOW);
  });

  it("appends to dispatchOrder across multiple dispatch rounds", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const r1 = dispatchNext(q, 1, NOW); // dispatch t1
    const completed = recordResult(r1.state, "t1", "ok", NOW + 100, true); // free the slot
    const r2 = dispatchNext(completed, 1, NOW + 200); // dispatch t2
    expect(r2.state.dispatchOrder).toEqual(["t1", "t2"]);
  });

  it("does not dispatch when maxConcurrent is reached", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const r1 = dispatchNext(q, 1, NOW); // dispatch t1
    const r2 = dispatchNext(r1.state, 1, NOW); // t1 still dispatched, no slot
    expect(r2.taskIds).toHaveLength(0);
  });

  it("does not dispatch when maxConcurrent is 0", () => {
    const q = createQueue([spec("t1")]);
    const { taskIds } = dispatchNext(q, 0, NOW);
    expect(taskIds).toHaveLength(0);
  });

  it("respects dependencies — does not dispatch until deps are completed", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
    ]);
    const r1 = dispatchNext(q, 2, NOW);
    expect(r1.taskIds).toEqual(["t1"]); // t2 waits for t1
    expect(r1.state.tasks.get("t2")?.status).toBe("queued");
  });

  it("dispatches dependents after dependency completes", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
    ]);
    const r1 = dispatchNext(q, 2, NOW);
    const r2 = recordResult(r1.state, "t1", "result", NOW + 100, true);
    const r3 = dispatchNext(r2, 2, NOW + 200);
    expect(r3.taskIds).toEqual(["t2"]);
    expect(r3.state.tasks.get("t2")?.status).toBe("dispatched");
  });

  it("does not mutate the original state", () => {
    const q = createQueue([spec("t1")]);
    dispatchNext(q, 1, NOW);
    expect(q.tasks.get("t1")?.status).toBe("queued");
  });
});

// ── recordResult ──────────────────────────────────────────────

describe("recordResult", () => {
  it("marks a dispatched task as completed on success", () => {
    const q = createQueue([spec("t1")]);
    const d = dispatchNext(q, 1, NOW);
    const r = recordResult(d.state, "t1", "done", NOW + 100, true);
    expect(r.tasks.get("t1")?.status).toBe("completed");
    expect(r.tasks.get("t1")?.result).toBe("done");
    expect(r.tasks.get("t1")?.completedAtMs).toBe(NOW + 100);
  });

  it("marks a dispatched task as failed on failure", () => {
    const q = createQueue([spec("t1")]);
    const d = dispatchNext(q, 1, NOW);
    const r = recordResult(d.state, "t1", "error msg", NOW + 100, false);
    expect(r.tasks.get("t1")?.status).toBe("failed");
    expect(r.tasks.get("t1")?.error).toBe("error msg");
    expect(r.tasks.get("t1")?.result).toBeUndefined();
  });

  it("appends to completionOrder", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 2, NOW);
    const r1 = recordResult(d.state, "t2", "r2", NOW + 100, true);
    const r2 = recordResult(r1, "t1", "r1", NOW + 200, true);
    expect(r2.completionOrder).toEqual(["t2", "t1"]);
  });

  it("is a no-op for an unknown task", () => {
    const q = createQueue([spec("t1")]);
    const r = recordResult(q, "unknown", "x", NOW, true);
    expect(r).toBe(q); // returns same state
  });

  it("does not mutate the original state", () => {
    const q = createQueue([spec("t1")]);
    const d = dispatchNext(q, 1, NOW);
    recordResult(d.state, "t1", "done", NOW + 100, true);
    expect(d.state.tasks.get("t1")?.status).toBe("dispatched");
  });
});

// ── failBlockedTasks ──────────────────────────────────────────

describe("failBlockedTasks", () => {
  it("fails tasks whose dependencies have failed", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
    ]);
    const d = dispatchNext(q, 1, NOW);
    const f = recordResult(d.state, "t1", "err", NOW + 100, false);
    const result = failBlockedTasks(f);
    expect(result.tasks.get("t2")?.status).toBe("failed");
    expect(result.tasks.get("t2")?.error).toContain("dependency failed");
  });

  it("does not fail tasks whose dependencies are still running", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
    ]);
    const d = dispatchNext(q, 1, NOW); // t1 dispatched, not yet complete
    const result = failBlockedTasks(d.state);
    expect(result.tasks.get("t2")?.status).toBe("queued");
  });

  it("does not fail tasks whose dependencies succeeded", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
    ]);
    const d = dispatchNext(q, 1, NOW);
    const r = recordResult(d.state, "t1", "ok", NOW + 100, true);
    const result = failBlockedTasks(r);
    expect(result.tasks.get("t2")?.status).toBe("queued");
  });

  it("returns the same state when nothing changes", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const result = failBlockedTasks(q);
    expect(result).toBe(q);
  });

  it("cascades failure transitively", () => {
    const q = createQueue([
      spec("t1"),
      spec("t2", { dependsOn: ["t1"] }),
      spec("t3", { dependsOn: ["t2"] }),
    ]);
    const d = dispatchNext(q, 1, NOW);
    const f1 = recordResult(d.state, "t1", "err", NOW + 100, false);
    const f2 = failBlockedTasks(f1); // t2 fails
    const f3 = failBlockedTasks(f2); // t3 fails (t2 now failed)
    expect(f3.tasks.get("t2")?.status).toBe("failed");
    expect(f3.tasks.get("t3")?.status).toBe("failed");
  });
});

// ── getResultsInOrder ─────────────────────────────────────────

describe("getResultsInOrder", () => {
  it("returns results in original spec order, not completion order", () => {
    const specs = [spec("t1"), spec("t2"), spec("t3")];
    const q = createQueue(specs);
    const d = dispatchNext(q, 3, NOW);
    // Complete in reverse order
    const r1 = recordResult(d.state, "t3", "r3", NOW + 300, true);
    const r2 = recordResult(r1, "t1", "r1", NOW + 100, true);
    const r3 = recordResult(r2, "t2", "r2", NOW + 200, true);

    const results = getResultsInOrder(r3, specs);
    expect(results.map((r) => r.spec.id)).toEqual(["t1", "t2", "t3"]);
    expect(results[0].result).toBe("r1");
    expect(results[1].result).toBe("r2");
    expect(results[2].result).toBe("r3");
  });

  it("includes status for each task", () => {
    const specs = [spec("t1"), spec("t2")];
    const q = createQueue(specs);
    const d = dispatchNext(q, 2, NOW);
    const r = recordResult(d.state, "t1", "ok", NOW + 100, true);

    const results = getResultsInOrder(r, specs);
    expect(results[0].status).toBe("completed");
    expect(results[1].status).toBe("dispatched");
  });

  it("includes error for failed tasks", () => {
    const specs = [spec("t1")];
    const q = createQueue(specs);
    const d = dispatchNext(q, 1, NOW);
    const r = recordResult(d.state, "t1", "boom", NOW + 100, false);

    const results = getResultsInOrder(r, specs);
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBe("boom");
  });

  it("defaults to 'queued' for specs not in the queue", () => {
    const specs = [spec("t1"), spec("t2")];
    const q = createQueue([spec("t1")]); // t2 not in queue
    const results = getResultsInOrder(q, specs);
    expect(results[1].status).toBe("queued");
  });
});

// ── computeProgress ───────────────────────────────────────────

describe("computeProgress", () => {
  it("counts all task statuses", () => {
    const q = createQueue([spec("t1"), spec("t2"), spec("t3"), spec("t4")]);
    const d = dispatchNext(q, 2, NOW); // 2 dispatched
    const r = recordResult(d.state, "t1", "ok", NOW + 100, true); // 1 completed

    const progress = computeProgress(r, 2);
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(1);
    expect(progress.dispatched).toBe(1);
    expect(progress.queued).toBe(2);
    expect(progress.failed).toBe(0);
  });

  it("reports activeSlots and canDispatch", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 2, NOW); // 2 dispatched
    const progress = computeProgress(d.state, 2);
    expect(progress.activeSlots).toBe(2);
    expect(progress.canDispatch).toBe(false); // at capacity
  });

  it("canDispatch is true when slots are available and tasks are queued", () => {
    const q = createQueue([spec("t1"), spec("t2"), spec("t3")]);
    const d = dispatchNext(q, 1, NOW); // 1 dispatched, 2 queued
    const progress = computeProgress(d.state, 2);
    expect(progress.canDispatch).toBe(true);
  });

  it("canDispatch is false when no tasks are queued", () => {
    const q = createQueue([spec("t1")]);
    const d = dispatchNext(q, 2, NOW);
    const progress = computeProgress(d.state, 2);
    expect(progress.canDispatch).toBe(false); // nothing queued
  });

  it("reports nextTaskIds for queued tasks with satisfied deps", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 1, NOW); // t1 dispatched, t2 queued
    const r = recordResult(d.state, "t1", "ok", NOW + 100, true); // t1 done
    const progress = computeProgress(r, 2);
    expect(progress.nextTaskIds).toContain("t2");
  });
});

// ── isComplete ────────────────────────────────────────────────

describe("isComplete", () => {
  it("returns true when all tasks are terminal (completed/failed)", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 2, NOW);
    const r1 = recordResult(d.state, "t1", "ok", NOW + 100, true);
    const r2 = recordResult(r1, "t2", "ok", NOW + 200, true);
    expect(isComplete(r2)).toBe(true);
  });

  it("returns false when tasks are still queued", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 1, NOW); // t2 still queued
    expect(isComplete(d.state)).toBe(false);
  });

  it("returns false when tasks are still dispatched", () => {
    const q = createQueue([spec("t1")]);
    const d = dispatchNext(q, 1, NOW); // t1 dispatched
    expect(isComplete(d.state)).toBe(false);
  });

  it("returns true for an empty queue", () => {
    const q = createQueue([]);
    expect(isComplete(q)).toBe(true);
  });

  it("returns true when all tasks failed", () => {
    const q = createQueue([spec("t1"), spec("t2")]);
    const d = dispatchNext(q, 2, NOW);
    const r1 = recordResult(d.state, "t1", "err", NOW + 100, false);
    const r2 = recordResult(r1, "t2", "err", NOW + 200, false);
    expect(isComplete(r2)).toBe(true);
  });
});

// ── computeEffectiveMaxConcurrent ─────────────────────────────

describe("computeEffectiveMaxConcurrent", () => {
  it("returns the configured value when healthy", () => {
    expect(computeEffectiveMaxConcurrent(5, "healthy")).toBe(5);
  });

  it("reduces by 2 when degraded (minimum 1)", () => {
    expect(computeEffectiveMaxConcurrent(5, "degraded")).toBe(3);
    expect(computeEffectiveMaxConcurrent(2, "degraded")).toBe(1); // clamped to 1
    expect(computeEffectiveMaxConcurrent(1, "degraded")).toBe(1); // clamped to 1
  });

  it("returns 0 when critical", () => {
    expect(computeEffectiveMaxConcurrent(5, "critical")).toBe(0);
  });
});
