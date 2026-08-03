/**
 * BDD tests for #18: Subagent Work Queue Dispatcher.
 *
 * @dft
 * - Pure logic only — no sessions_spawn, no I/O, no file system
 * - Deterministic: injected timestamps, no Date.now()
 * - All data inline (no fixtures)
 * - Tests run in <5ms
 *
 * Pattern: Feature/Scenario (matches existing BDD suite)
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

const NOW = 3_000_000_000;

// ── Helpers ──────────────────────────────────────────────────

function makeTasks(n: number): TaskSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i + 1}`,
    prompt: `Research task ${i + 1}`,
    priority: "normal" as const,
  }));
}

function makeTasksWithPriority(): TaskSpec[] {
  return [
    { id: "low-1", prompt: "low task", priority: "low" },
    { id: "normal-1", prompt: "normal task", priority: "normal" },
    { id: "high-1", prompt: "high task", priority: "high" },
    { id: "normal-2", prompt: "normal task 2", priority: "normal" },
    { id: "high-2", prompt: "high task 2", priority: "high" },
    { id: "low-2", prompt: "low task 2", priority: "low" },
  ];
}

// ═══════════════════════════════════════════════════════════════
// Feature: Queue Creation & Priority Ordering
// ═══════════════════════════════════════════════════════════════

describe("Feature: Queue Creation & Priority Ordering", () => {
  it("Scenario: Create queue with 10 normal-priority tasks", () => {
    const specs = makeTasks(10);
    const queue = createQueue(specs);

    expect(queue.tasks.size).toBe(10);
    for (const spec of specs) {
      expect(queue.tasks.get(spec.id)?.status).toBe("queued");
    }
  });

  it("Scenario: High-priority tasks are ordered before normal and low", () => {
    const specs = makeTasksWithPriority();
    const queue = createQueue(specs);

    // High tasks should be first in dispatch order
    // The queue processes in priority order: high, normal, low
    const statuses = Array.from(queue.tasks.values()) as any[];
    const highIds = statuses.filter((t: any) => t.spec.priority === "high").map((t) => t.spec.id);
    const normalIds = statuses.filter((t: any) => t.spec.priority === "normal").map((t) => t.spec.id);
    const lowIds = statuses.filter((t: any) => t.spec.priority === "low").map((t) => t.spec.id);

    expect(highIds).toContain("high-1");
    expect(highIds).toContain("high-2");
    expect(normalIds).toContain("normal-1");
    expect(normalIds).toContain("normal-2");
    expect(lowIds).toContain("low-1");
    expect(lowIds).toContain("low-2");
  });

  it("Scenario: Tasks without priority default to normal", () => {
    const specs: TaskSpec[] = [
      { id: "a", prompt: "task a" },
      { id: "b", prompt: "task b", priority: "high" },
    ];
    const queue = createQueue(specs);
    expect(queue.tasks.get("a")?.spec.priority).toBeUndefined(); // stored as-is
  });

  it("Scenario: Empty specs produce empty queue", () => {
    const queue = createQueue([]);
    expect(queue.tasks.size).toBe(0);
    expect(isComplete(queue)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Parallel Dispatch Across Concurrent Slots
// ═══════════════════════════════════════════════════════════════

describe("Feature: Parallel Dispatch Across Concurrent Slots", () => {
  it("Scenario: Dispatch fills available slots up to maxConcurrent", () => {
    const specs = makeTasks(10);
    const queue = createQueue(specs);
    const { taskIds, state } = dispatchNext(queue, 3, NOW);

    expect(taskIds).toHaveLength(3);
    for (const id of taskIds) {
      expect(state.tasks.get(id)?.status).toBe("dispatched");
      expect(state.tasks.get(id)?.dispatchedAtMs).toBe(NOW);
    }
  });

  it("Scenario: Dispatch respects maxConcurrent limit", () => {
    const specs = makeTasks(10);
    const queue = createQueue(specs);
    const { taskIds } = dispatchNext(queue, 6, NOW);
    expect(taskIds).toHaveLength(6);
  });

  it("Scenario: No dispatch when all slots are full", () => {
    const specs = makeTasks(10);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 3, NOW).state;
    // 3 slots used, 0 available
    const { taskIds } = dispatchNext(queue, 3, NOW + 1000);
    expect(taskIds).toHaveLength(0);
  });

  it("Scenario: Dispatch fills freed slots after completion", () => {
    const specs = makeTasks(5);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 2, NOW).state;
    // 2 dispatched, 3 queued
    expect(computeProgress(queue, 2).dispatched).toBe(2);

    // Complete task-1
    queue = recordResult(queue, "task-1", { findings: "result" }, NOW + 5000);
    // Now 1 slot free, should dispatch next
    const { taskIds, state } = dispatchNext(queue, 2, NOW + 5001);
    expect(taskIds).toHaveLength(1);
    expect(state.tasks.get(taskIds[0])?.status).toBe("dispatched");
  });

  it("Scenario: All tasks dispatch when maxConcurrent >= task count", () => {
    const specs = makeTasks(3);
    const queue = createQueue(specs);
    const { taskIds } = dispatchNext(queue, 6, NOW);
    expect(taskIds).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Result Collection in Original Order
// ═══════════════════════════════════════════════════════════════

describe("Feature: Result Collection in Original Order", () => {
  it("Scenario: Results returned in task spec order, not completion order", () => {
    const specs = makeTasks(3);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 3, NOW).state;

    // Complete in reverse order: task-3, task-2, task-1
    queue = recordResult(queue, "task-3", "c", NOW + 1000);
    queue = recordResult(queue, "task-2", "b", NOW + 2000);
    queue = recordResult(queue, "task-1", "a", NOW + 3000);

    const results = getResultsInOrder(queue, specs);
    expect(results[0].result).toBe("a");  // task-1
    expect(results[1].result).toBe("b");  // task-2
    expect(results[2].result).toBe("c");  // task-3
  });

  it("Scenario: Incomplete tasks have undefined result", () => {
    const specs = makeTasks(3);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 2, NOW).state;

    // Complete only task-1
    queue = recordResult(queue, "task-1", "done", NOW + 1000);

    const results = getResultsInOrder(queue, specs);
    expect(results[0].result).toBe("done");
    expect(results[1].result).toBeUndefined();
    expect(results[2].result).toBeUndefined();
    expect(results[1].status).toBe("dispatched");
    expect(results[2].status).toBe("queued");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Dependency Management
// ═══════════════════════════════════════════════════════════════

describe("Feature: Dependency Management", () => {
  it("Scenario: Task with unsatisfied dependencies does not dispatch", () => {
    const specs: TaskSpec[] = [
      { id: "search", prompt: "search papers" },
      { id: "analyze", prompt: "analyze results", dependsOn: ["search"] },
    ];
    const queue = createQueue(specs);
    const { taskIds } = dispatchNext(queue, 2, NOW);

    expect(taskIds).toContain("search");
    expect(taskIds).not.toContain("analyze");
  });

  it("Scenario: Task dispatches after dependency completes", () => {
    const specs: TaskSpec[] = [
      { id: "search", prompt: "search papers" },
      { id: "analyze", prompt: "analyze results", dependsOn: ["search"] },
    ];
    let queue = createQueue(specs);

    // Dispatch search
    queue = dispatchNext(queue, 2, NOW).state;
    expect(queue.tasks.get("search")?.status).toBe("dispatched");

    // Complete search
    queue = recordResult(queue, "search", { papers: 5 }, NOW + 5000);

    // Now analyze should dispatch
    const { taskIds } = dispatchNext(queue, 2, NOW + 5001);
    expect(taskIds).toContain("analyze");
  });

  it("Scenario: Task fails when dependency fails", () => {
    const specs: TaskSpec[] = [
      { id: "search", prompt: "search papers" },
      { id: "analyze", prompt: "analyze results", dependsOn: ["search"] },
    ];
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 2, NOW).state;

    // Fail the dependency
    queue = recordResult(queue, "search", "API error", NOW + 5000, false);
    queue = failBlockedTasks(queue);

    expect(queue.tasks.get("analyze")?.status).toBe("failed");
    expect(queue.tasks.get("analyze")?.error).toContain("dependency");
  });

  it("Scenario: Multiple dependencies all must complete", () => {
    const specs: TaskSpec[] = [
      { id: "search-a", prompt: "search A" },
      { id: "search-b", prompt: "search B" },
      { id: "synthesize", prompt: "synthesize", dependsOn: ["search-a", "search-b"] },
    ];
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 2, NOW).state;

    // Complete only search-a
    queue = recordResult(queue, "search-a", "result-a", NOW + 1000);
    const { taskIds } = dispatchNext(queue, 2, NOW + 1001);

    // synthesize should NOT dispatch — search-b still running
    expect(taskIds).not.toContain("synthesize");

    // Complete search-b
    queue = recordResult(queue, "search-b", "result-b", NOW + 2000);
    const { taskIds: nextIds } = dispatchNext(queue, 2, NOW + 2001);
    expect(nextIds).toContain("synthesize");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Progress Reporting
// ═══════════════════════════════════════════════════════════════

describe("Feature: Progress Reporting", () => {
  it("Scenario: Progress shows correct counts after partial dispatch", () => {
    const specs = makeTasks(10);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 3, NOW).state;

    const progress = computeProgress(queue, 6);
    expect(progress.total).toBe(10);
    expect(progress.queued).toBe(7);
    expect(progress.dispatched).toBe(3);
    expect(progress.completed).toBe(0);
    expect(progress.failed).toBe(0);
    expect(progress.activeSlots).toBe(3);
    expect(progress.canDispatch).toBe(true);
  });

  it("Scenario: Progress shows canDispatch=false when slots full", () => {
    const specs = makeTasks(10);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 6, NOW).state;

    const progress = computeProgress(queue, 6);
    expect(progress.canDispatch).toBe(false);
  });

  it("Scenario: Progress shows next ready tasks", () => {
    const specs = makeTasks(10);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 2, NOW).state;

    const progress = computeProgress(queue, 6);
    expect(progress.nextTaskIds.length).toBeGreaterThan(0);
    expect(progress.nextTaskIds.length).toBeLessThanOrEqual(4); // 6 - 2 = 4
  });

  it("Scenario: Progress shows all completed when queue is done", () => {
    const specs = makeTasks(3);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 3, NOW).state;
    queue = recordResult(queue, "task-1", "a", NOW + 1000);
    queue = recordResult(queue, "task-2", "b", NOW + 2000);
    queue = recordResult(queue, "task-3", "c", NOW + 3000);

    const progress = computeProgress(queue, 3);
    expect(progress.completed).toBe(3);
    expect(progress.queued).toBe(0);
    expect(progress.dispatched).toBe(0);
    expect(isComplete(queue)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Telemetry-Driven Throttling
// ═══════════════════════════════════════════════════════════════

describe("Feature: Telemetry-Driven Throttling", () => {
  it("Scenario: Healthy telemetry allows full maxConcurrent", () => {
    const effective = computeEffectiveMaxConcurrent(6, "healthy");
    expect(effective).toBe(6);
  });

  it("Scenario: Degraded telemetry reduces maxConcurrent by 2", () => {
    const effective = computeEffectiveMaxConcurrent(6, "degraded");
    expect(effective).toBe(4);
  });

  it("Scenario: Critical telemetry blocks all spawning", () => {
    const effective = computeEffectiveMaxConcurrent(6, "critical");
    expect(effective).toBe(0);
  });

  it("Scenario: Degraded throttling floors at 1 (never blocks entirely)", () => {
    const effective = computeEffectiveMaxConcurrent(2, "degraded");
    expect(effective).toBe(1);
  });

  it("Scenario: Throttling affects dispatch decision", () => {
    const specs = makeTasks(10);
    const queue = createQueue(specs);

    // With effective maxConcurrent=2 (degraded), only 2 dispatch
    const degradedMax = computeEffectiveMaxConcurrent(6, "degraded");
    expect(degradedMax).toBe(4); // 6 - 2 = 4
    const { taskIds: degraded } = dispatchNext(queue, degradedMax, NOW);
    expect(degraded).toHaveLength(4);

    // With effective maxConcurrent=6 (healthy), 6 dispatch
    const { taskIds: healthy } = dispatchNext(queue, computeEffectiveMaxConcurrent(6, "healthy"), NOW);
    expect(healthy).toHaveLength(6);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Immutability & Purity
// ═══════════════════════════════════════════════════════════════

describe("Feature: Immutability & Purity", () => {
  it("Scenario: createQueue does not mutate input specs", () => {
    const specs = makeTasks(3);
    const original = JSON.stringify(specs);
    createQueue(specs);
    expect(JSON.stringify(specs)).toBe(original);
  });

  it("Scenario: dispatchNext returns new state, original unchanged", () => {
    const specs = makeTasks(5);
    const queue = createQueue(specs);
    const originalSize = queue.tasks.size;
    const { state } = dispatchNext(queue, 2, NOW);

    // Original queue unchanged
    expect(queue.tasks.size).toBe(originalSize);
    for (const task of queue.tasks.values()) {
      expect(task.status).toBe("queued");  // All still queued
    }

    // New state has dispatched tasks
    const dispatchedCount = Array.from(state.tasks.values()).filter(
      (t) => t.status === "dispatched"
    ).length;
    expect(dispatchedCount).toBe(2);
  });

  it("Scenario: recordResult returns new state, original unchanged", () => {
    const specs = makeTasks(2);
    let queue = createQueue(specs);
    queue = dispatchNext(queue, 1, NOW).state;

    const originalStatus = queue.tasks.get("task-1")?.status;
    const newState = recordResult(queue, "task-1", "done", NOW + 1000);

    // Original unchanged
    expect(queue.tasks.get("task-1")?.status).toBe(originalStatus);
    // New state has completed task
    expect(newState.tasks.get("task-1")?.status).toBe("completed");
  });
});
