/**
 * Work Queue Pure Transition Algebra — batch queueing, status projection, and result merging.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns explicit CheckResult snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/work-queue/tests/logic.spec.ts.
 */

import {
  createQueue,
  dispatchNext,
  computeProgress,
  type TaskSpec,
} from "../../../../../shared/work-queue-scheduler.js";
import { mergeResults, type SubagentResult } from "../../../../../shared/result-merger.js";
import type { WorkQueueSliceConfig, WorkQueueSliceState } from "./state.js";

export function enqueueWorkBatch(
  _state: WorkQueueSliceState,
  config: WorkQueueSliceConfig,
  tasks: TaskSpec[],
  nowMs: number,
): { nextState: WorkQueueSliceState; queued: number; dispatched: number } {
  const q = createQueue(tasks);
  const { state: nextQ, taskIds } = dispatchNext(q, config.maxConcurrentSubagents, nowMs);
  return {
    queued: tasks.length,
    dispatched: taskIds.length,
    nextState: { queue: nextQ, specs: [...tasks] },
  };
}

export function projectWorkQueueStatus(
  state: WorkQueueSliceState,
  maxConcurrent = 6,
) {
  if (!state.queue) {
    return { ok: true, total: 0, queued: 0, dispatched: 0, completed: 0, failed: 0 };
  }
  const s = computeProgress(state.queue, maxConcurrent);
  return { ok: true, ...s };
}

export function mergeWorkOutputs(outputs: SubagentResult[]) {
  return mergeResults(outputs);
}
