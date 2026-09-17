/**
 * TaskPlane Logic — pure state machine and lifecycle engine.
 *
 * @behavior
 * Implements the core TaskPlane abstraction: unified task lifecycle management
 * across exec, subagent, wake, and cron tasks. Manages dispatch, state transitions,
 * supervisor timeout evaluation, and wake generation.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:child_process, node:path, etc.).
 * - No Date.now() / Math.random() — time is injected via options.nowMs.
 * - Mutating functions return a report (CheckResult pattern).
 *
 * @dft
 * - Pure logic tested in task-plane-logic.spec.ts with inline data.
 * - Zero fixtures, deterministic.
 */

import type {
  TaskPlaneTask,
  TaskPlaneKind,
  TaskPlaneStatus,
  TaskPlaneRegistry,
  TaskPlaneResult,
} from "../../shared/types.js";

export const DEFAULT_TASK_TIMEOUT_MS = 600000; // 10 minutes default

export interface DispatchTaskParams {
  id: string;
  kind?: TaskPlaneKind;
  payload: Record<string, unknown>;
  owner: string;
  timeoutMs?: number;
  output_handle?: string;
}

export interface TaskPlaneReport {
  action: "create" | "dispatch" | "start" | "complete" | "fail" | "kill" | "evaluateTimeouts";
  taskId?: string;
  timestamp: number;
  statusBefore?: TaskPlaneStatus;
  statusAfter?: TaskPlaneStatus;
  affectedTaskIds?: string[];
}

export interface TaskWakeEvent {
  targetSessionKey: string;
  event: "task_complete";
  taskId: string;
  kind: TaskPlaneKind;
  status: TaskPlaneStatus;
  output_handle: string;
  result?: TaskPlaneResult;
}

/**
 * Creates an empty TaskPlane registry.
 */
export function createRegistry(): TaskPlaneRegistry {
  return {
    tasks: {},
    version: 1,
  };
}

/**
 * Dispatches a new task into the registry in 'queued' status.
 * Non-blocking: returns immediately with new registry, task, and report.
 */
export function dispatchTask(
  registry: TaskPlaneRegistry,
  params: DispatchTaskParams,
  options: { nowMs: number }
): { registry: TaskPlaneRegistry; task: TaskPlaneTask; report: TaskPlaneReport } {
  const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TASK_TIMEOUT_MS;
  const kind = params.kind ?? "exec";
  const output_handle = params.output_handle ?? `output://${params.id}`;

  const task: TaskPlaneTask = {
    id: params.id,
    kind,
    payload: { ...params.payload },
    owner: params.owner,
    timeoutMs,
    status: "queued",
    output_handle,
    timestamps: {
      queuedAt: options.nowMs,
    },
  };

  const nextTasks = { ...registry.tasks, [task.id]: task };
  const nextRegistry: TaskPlaneRegistry = {
    ...registry,
    tasks: nextTasks,
    version: registry.version + 1,
  };

  const report: TaskPlaneReport = {
    action: "dispatch",
    taskId: task.id,
    timestamp: options.nowMs,
    statusBefore: undefined,
    statusAfter: "queued",
  };

  return { registry: nextRegistry, task, report };
}

/**
 * Marks a task as 'running' when the execution begins.
 */
export function startTask(
  registry: TaskPlaneRegistry,
  taskId: string,
  options: { nowMs: number; pid?: number; subagentSessionKey?: string }
): { registry: TaskPlaneRegistry; task: TaskPlaneTask | null; report: TaskPlaneReport } {
  const existing = registry.tasks[taskId];
  if (!existing) {
    return {
      registry,
      task: null,
      report: { action: "start", taskId, timestamp: options.nowMs },
    };
  }

  const updated: TaskPlaneTask = {
    ...existing,
    status: "running",
    pid: options.pid ?? existing.pid,
    subagentSessionKey: options.subagentSessionKey ?? existing.subagentSessionKey,
    timestamps: {
      ...existing.timestamps,
      startedAt: options.nowMs,
    },
  };

  const nextRegistry: TaskPlaneRegistry = {
    ...registry,
    tasks: { ...registry.tasks, [taskId]: updated },
    version: registry.version + 1,
  };

  const report: TaskPlaneReport = {
    action: "start",
    taskId,
    timestamp: options.nowMs,
    statusBefore: existing.status,
    statusAfter: "running",
  };

  return { registry: nextRegistry, task: updated, report };
}

/**
 * Completes a task successfully.
 */
export function completeTask(
  registry: TaskPlaneRegistry,
  taskId: string,
  result: TaskPlaneResult,
  options: { nowMs: number }
): { registry: TaskPlaneRegistry; task: TaskPlaneTask | null; wake: TaskWakeEvent | null; report: TaskPlaneReport } {
  const existing = registry.tasks[taskId];
  if (!existing) {
    return {
      registry,
      task: null,
      wake: null,
      report: { action: "complete", taskId, timestamp: options.nowMs },
    };
  }

  const updated: TaskPlaneTask = {
    ...existing,
    status: "done",
    result: { ...result },
    timestamps: {
      ...existing.timestamps,
      completedAt: options.nowMs,
    },
  };

  const nextRegistry: TaskPlaneRegistry = {
    ...registry,
    tasks: { ...registry.tasks, [taskId]: updated },
    version: registry.version + 1,
  };

  const wake = generateCompletionWake(updated);
  const report: TaskPlaneReport = {
    action: "complete",
    taskId,
    timestamp: options.nowMs,
    statusBefore: existing.status,
    statusAfter: "done",
  };

  return { registry: nextRegistry, task: updated, wake, report };
}

/**
 * Marks a task as failed.
 */
export function failTask(
  registry: TaskPlaneRegistry,
  taskId: string,
  error: string,
  options: { nowMs: number; exitCode?: number; outputTail?: string }
): { registry: TaskPlaneRegistry; task: TaskPlaneTask | null; wake: TaskWakeEvent | null; report: TaskPlaneReport } {
  const existing = registry.tasks[taskId];
  if (!existing) {
    return {
      registry,
      task: null,
      wake: null,
      report: { action: "fail", taskId, timestamp: options.nowMs },
    };
  }

  const updated: TaskPlaneTask = {
    ...existing,
    status: "failed",
    result: {
      error,
      exitCode: options.exitCode ?? existing.result?.exitCode,
      outputTail: options.outputTail ?? existing.result?.outputTail,
    },
    timestamps: {
      ...existing.timestamps,
      completedAt: options.nowMs,
    },
  };

  const nextRegistry: TaskPlaneRegistry = {
    ...registry,
    tasks: { ...registry.tasks, [taskId]: updated },
    version: registry.version + 1,
  };

  const wake = generateCompletionWake(updated);
  const report: TaskPlaneReport = {
    action: "fail",
    taskId,
    timestamp: options.nowMs,
    statusBefore: existing.status,
    statusAfter: "failed",
  };

  return { registry: nextRegistry, task: updated, wake, report };
}

/**
 * Kills/cancels a task. Preserves partial output and records reason.
 */
export function killTask(
  registry: TaskPlaneRegistry,
  taskId: string,
  reason: string,
  options: { nowMs: number; outputTail?: string }
): { registry: TaskPlaneRegistry; task: TaskPlaneTask | null; wake: TaskWakeEvent | null; report: TaskPlaneReport } {
  const existing = registry.tasks[taskId];
  if (!existing) {
    return {
      registry,
      task: null,
      wake: null,
      report: { action: "kill", taskId, timestamp: options.nowMs },
    };
  }

  const updated: TaskPlaneTask = {
    ...existing,
    status: "killed",
    result: {
      error: reason,
      outputTail: options.outputTail ?? existing.result?.outputTail,
    },
    timestamps: {
      ...existing.timestamps,
      completedAt: options.nowMs,
    },
  };

  const nextRegistry: TaskPlaneRegistry = {
    ...registry,
    tasks: { ...registry.tasks, [taskId]: updated },
    version: registry.version + 1,
  };

  const wake = generateCompletionWake(updated);
  const report: TaskPlaneReport = {
    action: "kill",
    taskId,
    timestamp: options.nowMs,
    statusBefore: existing.status,
    statusAfter: "killed",
  };

  return { registry: nextRegistry, task: updated, wake, report };
}

/**
 * Evaluates running tasks for timeout expiration.
 * Invariant 4: supervisor enforces per-task timeoutMs.
 */
export function evaluateTimeouts(
  registry: TaskPlaneRegistry,
  options: { nowMs: number }
): {
  registry: TaskPlaneRegistry;
  timedOutTasks: TaskPlaneTask[];
  wakes: TaskWakeEvent[];
  report: TaskPlaneReport;
} {
  const timedOutTasks: TaskPlaneTask[] = [];
  const wakes: TaskWakeEvent[] = [];
  const nextTasks = { ...registry.tasks };
  let modified = false;

  for (const [id, task] of Object.entries(registry.tasks)) {
    if (task.status === "running" && task.timestamps.startedAt) {
      const elapsed = options.nowMs - task.timestamps.startedAt;
      if (elapsed >= task.timeoutMs) {
        const updated: TaskPlaneTask = {
          ...task,
          status: "killed",
          result: {
            error: `Timeout exceeded: ran for ${elapsed}ms (cap: ${task.timeoutMs}ms)`,
            outputTail: task.result?.outputTail,
          },
          timestamps: {
            ...task.timestamps,
            completedAt: options.nowMs,
          },
        };
        nextTasks[id] = updated;
        timedOutTasks.push(updated);
        wakes.push(generateCompletionWake(updated));
        modified = true;
      }
    }
  }

  const nextRegistry: TaskPlaneRegistry = modified
    ? { ...registry, tasks: nextTasks, version: registry.version + 1 }
    : registry;

  const report: TaskPlaneReport = {
    action: "evaluateTimeouts",
    timestamp: options.nowMs,
    affectedTaskIds: timedOutTasks.map((t) => t.id),
  };

  return { registry: nextRegistry, timedOutTasks, wakes, report };
}

/**
 * Generates the one completion wake event for a finished task (push, not poll).
 * Invariant 2: push notification to owner session.
 */
export function generateCompletionWake(task: TaskPlaneTask): TaskWakeEvent {
  return {
    targetSessionKey: task.owner,
    event: "task_complete",
    taskId: task.id,
    kind: task.kind,
    status: task.status,
    output_handle: task.output_handle,
    result: task.result ? { ...task.result } : undefined,
  };
}

/**
 * Pure filter query for listing tasks.
 */
export function filterTasks(
  registry: TaskPlaneRegistry,
  filter?: {
    owner?: string;
    status?: TaskPlaneStatus;
    kind?: TaskPlaneKind;
  }
): TaskPlaneTask[] {
  let list = Object.values(registry.tasks);
  if (!filter) return list;

  if (filter.owner) {
    list = list.filter((t) => t.owner === filter.owner);
  }
  if (filter.status) {
    list = list.filter((t) => t.status === filter.status);
  }
  if (filter.kind) {
    list = list.filter((t) => t.kind === filter.kind);
  }
  return list;
}
