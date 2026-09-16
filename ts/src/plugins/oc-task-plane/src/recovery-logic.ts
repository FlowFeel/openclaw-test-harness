/**
 * Recovery Logic — pure restart reconciliation and process re-adoption engine.
 *
 * @behavior
 * Reconciles persisted TaskPlane registry against system state upon gateway startup.
 * Tasks whose OS processes survived downtime are re-adopted; tasks whose processes
 * perished are cleanly finalized with preserved output handles and owner notification wakes.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:child_process, node:path, etc.).
 * - No Date.now() / Math.random() — all time injected via options.nowMs.
 * - Mutating functions return a report (CheckResult pattern).
 *
 * @dft
 * - Pure logic tested in recovery-logic.spec.ts with inline data.
 * - Zero fixtures, deterministic.
 */

import type { TaskPlaneRegistry, TaskPlaneTask } from "../../shared/types.js";
import { generateCompletionWake, type TaskWakeEvent } from "./task-plane-logic.js";

export interface RecoveryWakeNotification {
  targetSessionKey: string;
  event: "task_readopted" | "task_complete";
  taskId: string;
  status: string;
  message: string;
  output_handle: string;
}

export interface RecoveryReport {
  reconciledAt: number;
  totalTasks: number;
  runningTasksFound: number;
  readoptedCount: number;
  finalizedDeadCount: number;
}

/**
 * Reconciles running tasks against alive OS process IDs.
 * Pure function: takes active PIDs as data, never queries OS directly.
 */
export function reconcileRestartState(
  registry: TaskPlaneRegistry,
  activePids: readonly number[],
  options: { nowMs: number }
): {
  registry: TaskPlaneRegistry;
  readoptedTasks: TaskPlaneTask[];
  deadTasks: TaskPlaneTask[];
  wakes: (TaskWakeEvent | RecoveryWakeNotification)[];
  report: RecoveryReport;
} {
  const activePidSet = new Set(activePids);
  const readoptedTasks: TaskPlaneTask[] = [];
  const deadTasks: TaskPlaneTask[] = [];
  const wakes: (TaskWakeEvent | RecoveryWakeNotification)[] = [];

  const nextTasks: Record<string, TaskPlaneTask> = { ...registry.tasks };
  let modified = false;
  let runningCount = 0;

  for (const [id, task] of Object.entries(registry.tasks)) {
    if (task.status === "running") {
      runningCount++;
      const isAlive = task.pid !== undefined && activePidSet.has(task.pid);

      if (isAlive) {
        // Process is still running! Re-adopt it.
        const updated: TaskPlaneTask = {
          ...task,
          readopted: true,
        };
        nextTasks[id] = updated;
        readoptedTasks.push(updated);
        wakes.push({
          targetSessionKey: task.owner,
          event: "task_readopted",
          taskId: task.id,
          status: "running",
          message: `Task ${task.id} (PID ${task.pid}) is still running and was re-adopted after gateway restart.`,
          output_handle: task.output_handle,
        });
        modified = true;
      } else {
        // Process terminated while gateway was offline.
        const updated: TaskPlaneTask = {
          ...task,
          status: "failed",
          result: {
            error: `Process ${task.pid ?? "unknown"} terminated while gateway was down. Output preserved.`,
            outputTail: task.result?.outputTail,
          },
          timestamps: {
            ...task.timestamps,
            completedAt: options.nowMs,
          },
        };
        nextTasks[id] = updated;
        deadTasks.push(updated);
        wakes.push(generateCompletionWake(updated));
        modified = true;
      }
    }
  }

  const nextRegistry: TaskPlaneRegistry = modified
    ? { ...registry, tasks: nextTasks, version: registry.version + 1 }
    : registry;

  const report: RecoveryReport = {
    reconciledAt: options.nowMs,
    totalTasks: Object.keys(registry.tasks).length,
    runningTasksFound: runningCount,
    readoptedCount: readoptedTasks.length,
    finalizedDeadCount: deadTasks.length,
  };

  return { registry: nextRegistry, readoptedTasks, deadTasks, wakes, report };
}
