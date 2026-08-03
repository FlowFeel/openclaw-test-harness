/**
 * Work Queue Scheduler — pure logic for batch task dispatch.
 *
 * @behavior
 * Accepts a batch of tasks, dispatches them across maxConcurrent slots,
 * and collects results in original task order (not completion order).
 * When a slot frees up, the next queued task dispatches.
 *
 * @invariants
 * - All functions are pure (input state → output state, no mutation)
 * - No Date.now() — uses injected timestamp
 * - No I/O — no sessions_spawn, no file system, no network
 * - No Math.random() — deterministic task IDs via injected counter
 * - Results collected in ORIGINAL task order, not completion order
 *
 * @dft
 * - All functions testable with inline data
 * - State is immutable (each operation returns new state)
 * - Deterministic: injected clock + injected counter
 */

// ── Types ─────────────────────────────────────────────────────

export type TaskStatus = "queued" | "dispatched" | "completed" | "failed";

export interface TaskSpec {
  id: string;
  prompt: string;
  priority?: "high" | "normal" | "low";
  dependsOn?: string[];
}

export interface TaskState {
  spec: TaskSpec;
  status: TaskStatus;
  dispatchedAtMs?: number;
  completedAtMs?: number;
  result?: unknown;
  error?: string;
}

export interface WorkQueueState {
  tasks: Map<string, TaskState>;
  dispatchOrder: string[];  // Order tasks were dispatched
  completionOrder: string[];  // Order tasks completed
}

export interface DispatchResult {
  taskIds: string[];  // IDs to dispatch now
  state: WorkQueueState;
}

export interface ProgressReport {
  total: number;
  queued: number;
  dispatched: number;
  completed: number;
  failed: number;
  activeSlots: number;
  maxConcurrent: number;
  canDispatch: boolean;
  nextTaskIds: string[];  // Next tasks ready to dispatch
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Create a new work queue from a batch of task specs.
 * All tasks start as "queued".
 */
export function createQueue(specs: TaskSpec[]): WorkQueueState {
  const tasks = new Map<string, TaskState>();
  const order: string[] = [];

  for (const spec of specs) {
    // Insert by priority: high first, then normal, then low
    const priority = spec.priority ?? "normal";
    let insertIndex = order.length;

    if (priority === "high") {
      // Insert before first non-high
      insertIndex = order.findIndex((id) => {
        const t = tasks.get(id);
        const p = t?.spec.priority ?? "normal";
        return p !== "high";
      });
      if (insertIndex === -1) insertIndex = order.length;
    } else if (priority === "low") {
      // Insert at end (after everything)
      insertIndex = order.length;
    } else {
      // Normal: after all high, before all low
      insertIndex = order.findIndex((id) => {
        const t = tasks.get(id);
        return (t?.spec.priority ?? "normal") === "low";
      });
      if (insertIndex === -1) insertIndex = order.length;
    }

    order.splice(insertIndex, 0, spec.id);
    tasks.set(spec.id, { spec, status: "queued" });
  }

  return {
    tasks,
    dispatchOrder: [],
    completionOrder: [],
  };
}

/**
 * Determine which queued tasks can dispatch now, respecting:
 * - maxConcurrent limit (active slots)
 * - dependencies (dependsOn must be completed, not failed)
 *
 * Returns the task IDs to dispatch and the updated state.
 */
export function dispatchNext(
  state: WorkQueueState,
  maxConcurrent: number,
  nowMs: number
): DispatchResult {
  const activeCount = Array.from(state.tasks.values()).filter(
    (t) => t.status === "dispatched"
  ).length;

  const availableSlots = maxConcurrent - activeCount;
  if (availableSlots <= 0) {
    return { taskIds: [], state };
  }

  // Find queued tasks whose dependencies are satisfied
  const dispatchable: string[] = [];
  for (const [id, task] of state.tasks) {
    if (task.status !== "queued") continue;
    if (dispatchable.length >= availableSlots) break;

    // Check dependencies
    const deps = task.spec.dependsOn ?? [];
    const depsSatisfied = deps.every((depId) => {
      const dep = state.tasks.get(depId);
      return dep && dep.status === "completed";
    });

    const depsFailed = deps.some((depId) => {
      const dep = state.tasks.get(depId);
      return dep && dep.status === "failed";
    });

    if (depsFailed) {
      // Mark as failed — dependency failed
      continue;
    }

    if (depsSatisfied) {
      dispatchable.push(id);
    }
  }

  // Update state: mark dispatched tasks
  const newTasks = new Map(state.tasks);
  const newDispatchOrder = [...state.dispatchOrder];
  for (const id of dispatchable) {
    const task = newTasks.get(id)!;
    newTasks.set(id, {
      ...task,
      status: "dispatched",
      dispatchedAtMs: nowMs,
    });
    newDispatchOrder.push(id);
  }

  return {
    taskIds: dispatchable,
    state: {
      tasks: newTasks,
      dispatchOrder: newDispatchOrder,
      completionOrder: state.completionOrder,
    },
  };
}

/**
 * Record a task result (success or failure).
 * Returns updated state with the task marked completed/failed.
 */
export function recordResult(
  state: WorkQueueState,
  taskId: string,
  result: unknown,
  nowMs: number,
  success: boolean = true
): WorkQueueState {
  const newTasks = new Map(state.tasks);
  const task = newTasks.get(taskId);
  if (!task) return state;

  newTasks.set(taskId, {
    ...task,
    status: success ? "completed" : "failed",
    completedAtMs: nowMs,
    result: success ? result : undefined,
    error: success ? undefined : String(result),
  });

  const newCompletionOrder = [...state.completionOrder, taskId];

  return {
    tasks: newTasks,
    dispatchOrder: state.dispatchOrder,
    completionOrder: newCompletionOrder,
  };
}

/**
 * Mark tasks with failed dependencies as failed.
 * Returns updated state.
 */
export function failBlockedTasks(state: WorkQueueState): WorkQueueState {
  const newTasks = new Map(state.tasks);
  let changed = false;

  for (const [id, task] of newTasks) {
    if (task.status !== "queued") continue;

    const deps = task.spec.dependsOn ?? [];
    const hasFailedDep = deps.some((depId) => {
      const dep = newTasks.get(depId);
      return dep && dep.status === "failed";
    });

    if (hasFailedDep) {
      const failedDepId = deps.find((depId) => {
        const dep = newTasks.get(depId);
        return dep && dep.status === "failed";
      });
      newTasks.set(id, {
        ...task,
        status: "failed",
        error: `dependency failed: ${failedDepId}`,
      });
      changed = true;
    }
  }

  return changed
    ? {
        tasks: newTasks,
        dispatchOrder: state.dispatchOrder,
        completionOrder: state.completionOrder,
      }
    : state;
}

/**
 * Get results in original task order (not completion order).
 */
export function getResultsInOrder(
  state: WorkQueueState,
  originalSpecs: TaskSpec[]
): Array<{ spec: TaskSpec; result?: unknown; error?: string; status: TaskStatus }> {
  return originalSpecs.map((spec) => {
    const task = state.tasks.get(spec.id);
    return {
      spec,
      result: task?.result,
      error: task?.error,
      status: task?.status ?? "queued",
    };
  });
}

/**
 * Compute a progress report for the queue.
 */
export function computeProgress(
  state: WorkQueueState,
  maxConcurrent: number
): ProgressReport {
  let queued = 0;
  let dispatched = 0;
  let completed = 0;
  let failed = 0;
  const nextTaskIds: string[] = [];

  for (const [id, task] of state.tasks) {
    switch (task.status) {
      case "queued":
        queued++;
        // Check if this task can dispatch next
        const deps = task.spec.dependsOn ?? [];
        const depsSatisfied = deps.every((depId) => {
          const dep = state.tasks.get(depId);
          return dep && dep.status === "completed";
        });
        if (depsSatisfied && nextTaskIds.length < (maxConcurrent - dispatched)) {
          nextTaskIds.push(id);
        }
        break;
      case "dispatched":
        dispatched++;
        break;
      case "completed":
        completed++;
        break;
      case "failed":
        failed++;
        break;
    }
  }

  const total = state.tasks.size;
  const activeSlots = dispatched;
  const canDispatch = activeSlots < maxConcurrent && queued > 0;

  return {
    total,
    queued,
    dispatched,
    completed,
    failed,
    activeSlots,
    maxConcurrent,
    canDispatch,
    nextTaskIds: nextTaskIds.slice(0, Math.max(0, maxConcurrent - activeSlots)),
  };
}

/**
 * Check if the queue is empty (all tasks are in terminal state).
 */
export function isComplete(state: WorkQueueState): boolean {
  for (const task of state.tasks.values()) {
    if (task.status === "queued" || task.status === "dispatched") {
      return false;
    }
  }
  return true;
}

/**
 * Get the effective max concurrent, given optional telemetry throttling.
 * If telemetry says degraded, reduce by 2. If critical, set to 0.
 */
export function computeEffectiveMaxConcurrent(
  configured: number,
  status: "healthy" | "degraded" | "critical"
): number {
  switch (status) {
    case "healthy":
      return configured;
    case "degraded":
      return Math.max(1, configured - 2);
    case "critical":
      return 0;
  }
}
