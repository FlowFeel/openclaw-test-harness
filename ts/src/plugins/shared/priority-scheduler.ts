/**
 * Priority Scheduler — pure logic for priority-based task scheduling & preemption.
 *
 * @behavior
 * - Tasks are inserted into a queue ordered by priority (high > normal > low).
 * - High-priority tasks can preempt low-priority running tasks.
 * - Preempted tasks yield cooperatively and are requeued at the front.
 *
 * @invariants
 * - All functions are pure (input state → output state, no mutation)
 * - No Date.now() — all timestamps are injected
 * - No I/O — no sessions_spawn, no file system, no network
 * - No Math.random() — deterministic
 *
 * @dft
 * - All functions testable with inline data
 * - Deterministic: same inputs always produce same outputs
 */

import {
  type TaskSpec,
  type TaskState,
} from "./work-queue-scheduler.js";

// ── Priority ordering ──────────────────────────────────────────

type PriorityLevel = "high" | "normal" | "low";

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

function rank(priority: string | undefined): number {
  return PRIORITY_RANK[priority as PriorityLevel] ?? PRIORITY_RANK.normal;
}

// ── Priority Insertion ─────────────────────────────────────────

/**
 * Insert a task into the queue maintaining priority order:
 * high before normal before low.
 *
 * Returns a NEW array (immutable). Does not modify the input.
 */
export function insertByPriority(
  queue: TaskSpec[],
  task: TaskSpec
): TaskSpec[] {
  const taskRank = rank(task.priority);

  // Find the index where this task's priority rank belongs
  let insertAt = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const existingRank = rank(queue[i].priority);
    if (taskRank < existingRank) {
      // This task is higher priority than the existing one at i
      insertAt = i;
      break;
    }
    // Normal priority tasks go after all high, before low.
    // "normal" tasks should be slotted after all high tasks but before low tasks.
    // Since ranks are high=0, normal=1, low=2, the simple rank comparison works,
    // BUT we need to ensure same-priority tasks are FIFO within their tier.
    // For "low" tasks we always append, which is the default.
    // For "normal" we want after all high, and for "high" we want before any non-high.
    // The rank comparison handles that correctly.
    // However: two "normal" tasks should keep insertion order.
    // The current loop stops at the first task with higher rank. For normal (1),
    // high tasks have rank 0 (lower), so we skip them. Then we stop at the first
    // low (2) or end. For two normals, existingAt(i)=1, new=1, 1<1 is false, so we
    // keep going. This means normals append after all existing normals. Good.
    // But what about inserting a high after existing high? 0<0 is false, so it appends
    // after all high — also fine for FIFO.
  }

  const result = queue.slice(0, insertAt);
  result.push(task);
  for (let i = insertAt; i < queue.length; i++) {
    result.push(queue[i]);
  }
  return result;
}

// ── Preemption Decision ─────────────────────────────────────────

/**
 * Determine whether an incoming task should preempt a currently running task.
 *
 * Rules:
 * - high preempts low (different priority level gap ≥ 2)
 * - high does NOT preempt normal (gap is 1)
 * - normal never preempts anything
 * - same priority never preempts
 *
 * Returns true if the incoming task should preempt the running task.
 */
export function shouldPreempt(
  running: TaskState,
  incoming: TaskSpec
): boolean {
  // Only high preempts low — requires a gap of at least 2 priority levels
  return (
    rank(incoming.priority) + 2 <= rank(running.spec.priority)
  );
}

// ── Yield Signal ───────────────────────────────────────────────

/**
 * Generate a cooperative preemption yield signal for a running task.
 *
 * The signal is advisory only — the running task is expected to respond
 * by pausing its work and saving partial results.
 *
 * Returns { taskId, reason } that the scheduler can pass to the task.
 */
export function yieldSignal(
  runningTask: TaskState
): { taskId: string; reason: string } {
  return {
    taskId: runningTask.spec.id,
    reason: `preempted by higher-priority task`,
  };
}

// ── Requeue After Preemption ───────────────────────────────────

/**
 * Requeue a preempted task by placing it at the front of the queue.
 *
 * The preempted task preserves its original priority.
 * The rest of the queue keeps its relative ordering.
 *
 * Returns a NEW array (immutable). Does not modify the input.
 */
export function requeuePreempted(
  task: TaskState,
  queue: TaskSpec[]
): TaskSpec[] {
  return [task.spec, ...queue];
}