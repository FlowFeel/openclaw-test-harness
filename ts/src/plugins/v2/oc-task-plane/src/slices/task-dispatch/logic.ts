/**
 * Task Dispatch Pure Transition Algebra — dispatch, status, cancel, timeout tick, and restart reconciliation.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns immutable TaskDispatchSliceState snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/task-dispatch/tests/logic.spec.ts.
 */

import type { TaskPlaneKind, TaskPlaneRegistry, TaskPlaneTask } from "../../../../../shared/types.js";
import {
  dispatchTask,
  startTask,
  completeTask,
  failTask,
  killTask,
  evaluateTimeouts,
  filterTasks,
} from "../../task-plane-logic.js";
import { classifyCommand, type ClassificationResult } from "../../classifier-logic.js";
import { reconcileRestartState } from "../../recovery-logic.js";
import type { TaskDispatchSliceConfig, TaskDispatchSliceState } from "./state.js";

/**
 * Pure Open-World Assumption (OWA) payload normalizer.
 *
 * Plain objects are shallow-cloned verbatim with zero key filtering or schema
 * gating. Non-plain values (arrays, primitives, null) are preserved verbatim
 * under `{ raw }` rather than silently dropped or coerced into numeric keys.
 */
export function normalizeOwaPayload(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return { raw };
}

export function dispatchNewTask(
  state: TaskDispatchSliceState,
  config: TaskDispatchSliceConfig,
  params: {
    command: string;
    kind: TaskPlaneKind;
    owner: string;
    timeoutMs?: number;
    payload?: unknown;
    nowMs: number;
  },
): {
  nextState: TaskDispatchSliceState;
  task: TaskPlaneTask;
  classification: ClassificationResult;
} {
  const { result: classification }: { result: ClassificationResult } = params.command
    ? classifyCommand(params.command, state.commandHistory, { nowMs: params.nowMs })
    : { result: { isLongRunner: false, advice: "", recommendation: "foreground" } };

  const nextCounter = state.taskCounter + 1;
  const taskId = `task-${params.nowMs}-${nextCounter}`;
  const outputHandle = `${config.outputDir}/${taskId}.log`;
  const effectiveTimeout =
    params.timeoutMs ?? classification.suggestedTimeoutMs ?? config.defaultTimeoutMs;
  const normalizedPayload = normalizeOwaPayload(params.payload);
  const payload = params.command
    ? { ...normalizedPayload, command: params.command }
    : normalizedPayload;

  const dispatched = dispatchTask(
    state.registry,
    {
      id: taskId,
      kind: params.kind,
      payload,
      owner: params.owner,
      timeoutMs: effectiveTimeout,
      output_handle: outputHandle,
    },
    { nowMs: params.nowMs },
  );

  let registry = dispatched.registry;
  let task = dispatched.task;
  if (params.kind === "exec") {
    const started = startTask(registry, task.id, { nowMs: params.nowMs });
    registry = started.registry;
    if (started.task) task = started.task;
  }

  return {
    task,
    classification,
    nextState: { ...state, registry, taskCounter: nextCounter },
  };
}

export function markTaskStarted(
  state: TaskDispatchSliceState,
  taskId: string,
  pid: number | undefined,
  nowMs: number,
) {
  const res = startTask(state.registry, taskId, { nowMs, pid });
  return {
    nextState: { ...state, registry: res.registry },
    task: res.task,
  };
}

export function transitionTaskComplete(
  state: TaskDispatchSliceState,
  taskId: string,
  exitCode: number | null,
  nowMs: number,
) {
  const res =
    exitCode === 0
      ? completeTask(state.registry, taskId, { exitCode: 0 }, { nowMs })
      : failTask(state.registry, taskId, `Exited with code ${exitCode ?? -1}`, { nowMs });
  return {
    nextState: { ...state, registry: res.registry },
    wake: res.wake,
  };
}

export function transitionTaskCancel(
  state: TaskDispatchSliceState,
  taskId: string,
  reason: string,
  nowMs: number,
) {
  const res = killTask(state.registry, taskId, reason, { nowMs });
  return {
    nextState: { ...state, registry: res.registry },
    task: res.task,
  };
}

export function queryTaskStatus(state: TaskDispatchSliceState, taskId?: string) {
  if (taskId) {
    const t = state.registry.tasks[taskId];
    return { tasks: t ? [t] : [], total: t ? 1 : 0 };
  }
  const tasks = filterTasks(state.registry);
  return { tasks, total: tasks.length };
}

export function stepTimeoutSupervisor(state: TaskDispatchSliceState, nowMs: number) {
  const res = evaluateTimeouts(state.registry, { nowMs });
  return {
    nextState: { ...state, registry: res.registry },
    timedOutTasks: res.timedOutTasks,
    wakes: res.wakes,
  };
}

export function stepRestartReconciliation(
  state: TaskDispatchSliceState,
  diskRegistry: TaskPlaneRegistry,
  runningPids: number[],
  nowMs: number,
) {
  const res = reconcileRestartState(diskRegistry, runningPids, { nowMs });
  return {
    nextState: { ...state, registry: res.registry },
    wakes: res.wakes,
  };
}
