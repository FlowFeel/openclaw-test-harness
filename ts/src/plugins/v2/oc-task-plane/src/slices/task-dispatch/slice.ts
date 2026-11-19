/**
 * Task Dispatch Slice Adapter — binds task_dispatch, task_status, task_output, task_cancel,
 * and gateway_start / gateway_stop reconciliation & timeout supervision.
 *
 * @invariants
 * - All filesystem/process/wake I/O mediated via injectable Protocols (A1/A5).
 * - Zero empty catch blocks; all kill/wake errors logged via api.logger.
 *
 * @dft
 * - Tested via oc-task-plane integration & manifest specs.
 */

import { Type, type PluginApi, type TaskPlaneKind } from "../../../../../shared/types.js";
import type { TaskWakeEvent } from "../../task-plane-logic.js";
import {
  readTaskRegistry,
  writeTaskRegistry,
  appendTaskOutput,
  readTaskOutput,
  isPidAlive,
  defaultProcessSpawner,
  readRepoShippedState,
  type TaskRegistryReader,
  type TaskRegistryWriter,
  type OutputAppender,
  type OutputReader,
  type PidChecker,
  type ProcessSpawner,
  type ShippedStateReader,
} from "../../task-plane-io.js";
import {
  defaultGatewayWakeSender,
  formatTaskWakeMessage,
  type GatewayWakeSender,
} from "../../task-plane-wake.js";
import { formatPostKillTeachback } from "../../teachback-logic.js";
import { createTaskDispatchState, type TaskDispatchSliceConfig } from "./state.js";
import {
  dispatchNewTask,
  markTaskStarted,
  transitionTaskComplete,
  transitionTaskCancel,
  queryTaskStatus,
  stepTimeoutSupervisor,
  stepRestartReconciliation,
} from "./logic.js";

export interface TaskDispatchIoDeps {
  reader?: TaskRegistryReader;
  writer?: TaskRegistryWriter;
  appender?: OutputAppender;
  outputReader?: OutputReader;
  pidChecker?: PidChecker;
  spawner?: ProcessSpawner;
  shippedStateReader?: ShippedStateReader;
  wakeSender?: GatewayWakeSender;
  clock?: () => number;
}

export interface TaskDispatchSliceHandle {
  onGatewayStart: () => void;
  onGatewayStop: () => void;
}

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function bindTaskDispatchSlice(
  api: PluginApi,
  config: TaskDispatchSliceConfig,
  deps: TaskDispatchIoDeps = {},
): TaskDispatchSliceHandle {
  const reader = deps.reader ?? readTaskRegistry;
  const writer = deps.writer ?? writeTaskRegistry;
  const appender = deps.appender ?? appendTaskOutput;
  const outputReader = deps.outputReader ?? readTaskOutput;
  const pidChecker = deps.pidChecker ?? isPidAlive;
  const spawner = deps.spawner ?? defaultProcessSpawner;
  const shippedStateReader = deps.shippedStateReader ?? readRepoShippedState;
  const wakeSender = deps.wakeSender ?? defaultGatewayWakeSender;
  const clock = deps.clock ?? (() => Date.now());

  let state = createTaskDispatchState(reader(config.registryPath));
  let supervisorTimer: NodeJS.Timeout | null = null;

  function persist() {
    writer(state.registry, config.registryPath);
  }

  function sendWake(wake: TaskWakeEvent) {
    wakeSender({
      sessionKey: wake.targetSessionKey,
      mode: "next-heartbeat",
      text: formatTaskWakeMessage(wake),
    }).catch((err) => {
      api.logger?.warn?.(`[oc-task-plane] wake dispatch failed: ${String(err)}`);
    });
  }

  api.registerTool({
    name: "task_dispatch",
    description: "Dispatches an asynchronous, lock-free task and returns immediately with a task ID.",
    parameters: Type.Object({
      command: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      payload: Type.Optional(Type.Any()),
    }),
    async execute(_id, params) {
      const command = typeof params.command === "string" ? params.command : "";
      const kind = (typeof params.kind === "string" ? params.kind : "durable") as TaskPlaneKind;
      const owner = typeof params.owner === "string" ? params.owner : "session-main";
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
      const rawPayload =
        params.payload && typeof params.payload === "object"
          ? (params.payload as Record<string, unknown>)
          : {};

      const { nextState, task, classification } = dispatchNewTask(state, config, {
        command,
        kind,
        owner,
        timeoutMs,
        payload: rawPayload,
        nowMs: clock(),
      });
      state = nextState;
      persist();

      if (kind === "exec" && command) {
        const spawned = spawner(command, {
          cwd: typeof rawPayload.cwd === "string" ? rawPayload.cwd : undefined,
          onStdoutChunk: (chunk) => appender(task.output_handle, chunk),
          onStderrChunk: (chunk) => appender(task.output_handle, chunk),
          onExit: (exitCode) => {
            state.runningProcesses.delete(task.id);
            const res = transitionTaskComplete(state, task.id, exitCode, clock());
            state = res.nextState;
            persist();
            if (res.wake) sendWake(res.wake);
          },
        });
        state.runningProcesses.set(task.id, spawned);
        if (spawned.pid !== undefined) {
          const started = markTaskStarted(state, task.id, spawned.pid, clock());
          state = started.nextState;
          persist();
        }
      }

      return jsonText({
        ok: true,
        taskId: task.id,
        status: task.status,
        outputHandle: task.output_handle,
        classification,
      });
    },
  });

  api.registerTool({
    name: "task_status",
    description: "Query status of a specific task or list all active/recent tasks.",
    parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
      const res = queryTaskStatus(state, taskId);
      if (taskId) {
        const task = res.tasks[0];
        return jsonText(task ? { ok: true, task } : { ok: false, error: `Task not found: ${taskId}` });
      }
      return jsonText({ ok: true, ...res });
    },
  });

  api.registerTool({
    name: "task_output",
    description: "Read incremental output tail for a dispatched task.",
    parameters: Type.Object({
      taskId: Type.String(),
      maxBytes: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const taskId = String(params.taskId ?? "");
      const task = state.registry.tasks[taskId];
      if (!task) return jsonText({ ok: false, error: `Task not found: ${taskId}` });
      const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 16384;
      const output = outputReader(task.output_handle, { maxBytes });
      return jsonText({ ok: true, taskId, status: task.status, output });
    },
  });

  api.registerTool({
    name: "task_cancel",
    description: "Cancel a running task and terminate its underlying process if active.",
    parameters: Type.Object({
      taskId: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const taskId = String(params.taskId ?? "");
      const reason = typeof params.reason === "string" ? params.reason : "Cancelled by user";
      const proc = state.runningProcesses.get(taskId);
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch (err) {
          api.logger?.warn?.(`[oc-task-plane] kill failed for ${taskId}: ${String(err)}`);
        }
        state.runningProcesses.delete(taskId);
      }
      const res = transitionTaskCancel(state, taskId, reason, clock());
      state = res.nextState;
      persist();
      return jsonText({ ok: Boolean(res.task), taskId, status: res.task?.status ?? "not_found" });
    },
  });

  return {
    onGatewayStart() {
      const disk = reader(config.registryPath);
      if (disk) {
        const runningPids: number[] = [];
        for (const task of Object.values(disk.tasks)) {
          if (task.status === "running" && task.pid !== undefined && pidChecker(task.pid)) {
            runningPids.push(task.pid);
          }
        }
        const rec = stepRestartReconciliation(state, disk, runningPids, clock());
        state = rec.nextState;
        persist();
        for (const w of rec.wakes) sendWake(w as TaskWakeEvent);
      }

      supervisorTimer = setInterval(() => {
        const now = clock();
        const step = stepTimeoutSupervisor(state, now);
        if (step.timedOutTasks.length === 0) return;
        state = step.nextState;
        persist();
        for (const task of step.timedOutTasks) {
          const proc = state.runningProcesses.get(task.id);
          if (proc) {
            try {
              proc.kill("SIGKILL");
            } catch (err) {
              api.logger?.warn?.(`[oc-task-plane] timeout kill failed for ${task.id}: ${String(err)}`);
            }
            state.runningProcesses.delete(task.id);
          }
          const cwd = typeof task.payload.cwd === "string" ? task.payload.cwd : undefined;
          if (cwd) {
            const shipped = shippedStateReader(cwd);
            formatPostKillTeachback(task, { nowMs: now, shippedState: shipped });
          }
        }
        for (const w of step.wakes) sendWake(w);
      }, config.supervisorIntervalMs);
    },
    onGatewayStop() {
      if (supervisorTimer) {
        clearInterval(supervisorTimer);
        supervisorTimer = null;
      }
    },
  };
}
