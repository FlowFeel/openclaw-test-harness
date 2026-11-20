/**
 * Task Dispatch State Slice — owns TaskPlaneRegistry, running process handles, and task counter.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to work-queue, watchdog, or durable-proxy slices.
 *
 * @dft
 * - Tested directly via slices/task-dispatch/tests/logic.spec.ts.
 */

import type { TaskPlaneRegistry } from "../../../../../shared/types.js";
import { createRegistry } from "../../task-plane-logic.js";
import type { SpawnedProcess } from "../../task-plane-io.js";
import type { CommandHistoryRecord } from "../../classifier-logic.js";

export interface TaskDispatchSliceConfig {
  registryPath: string;
  outputDir: string;
  defaultTimeoutMs: number;
  supervisorIntervalMs: number;
}

export interface TaskDispatchSliceState {
  readonly registry: TaskPlaneRegistry;
  readonly runningProcesses: Map<string, SpawnedProcess>;
  readonly commandHistory: CommandHistoryRecord[];
  readonly taskCounter: number;
}

export function createTaskDispatchState(
  initialRegistry?: TaskPlaneRegistry | null,
): TaskDispatchSliceState {
  return {
    registry: initialRegistry ?? createRegistry(),
    runningProcesses: new Map(),
    commandHistory: [],
    taskCounter: 0,
  };
}

