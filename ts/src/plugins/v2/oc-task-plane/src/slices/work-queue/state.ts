/**
 * Work Queue State Slice — owns WorkQueueState and original TaskSpec batch definitions.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to task-dispatch or durable-proxy slices.
 *
 * @dft
 * - Tested directly via slices/work-queue/tests/logic.spec.ts.
 */

import type { WorkQueueState } from "../../../../../shared/work-queue-scheduler.js";
import type { TaskSpec } from "../../../../../shared/work-queue-scheduler.js";

export interface WorkQueueSliceConfig {
  maxConcurrentSubagents: number;
}

export interface WorkQueueSliceState {
  readonly queue: WorkQueueState | null;
  readonly specs: readonly TaskSpec[];
}

export function createWorkQueueSliceState(): WorkQueueSliceState {
  return { queue: null, specs: [] };
}

