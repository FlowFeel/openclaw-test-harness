/**
 * OcTaskPlane — plugin entry point (wiring layer).
 *
 * @behavior
 * Implements TaskPlane: a lock-free task abstraction for OpenClaw agents.
 * Wires the agent tools (task_dispatch, task_status, task_output, task_cancel)
 * and gateway lifecycle hooks (gateway_start, gateway_stop) to pure logic seams
 * via the crash-safe I/O Protocol wrapper.
 *
 * @invariants
 * - No direct node:fs imports — all persistence and output handle I/O goes through task-plane-io.ts.
 * - All state transition decisions are delegated to task-plane-logic.ts.
 * - Classification heuristics are delegated to classifier-logic.ts.
 * - Restart recovery reconciliation is delegated to recovery-logic.ts.
 * - Diagnostics formatting is delegated to teachback-logic.ts.
 * - Dispatch never blocks the event loop or holds semaphore locks.
 *
 * @dft
 * - Tested via unit specs (pure seams) and integration specs with in-memory Protocol doubles.
 * - Conforms to the six phosphene DFT axioms.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import type {
  TaskPlaneRegistry,
  TaskPlaneTask,
  TaskPlaneKind,
  TaskPlaneStatus,
} from "../../shared/types.js";
import {
  createRegistry,
  dispatchTask,
  startTask,
  completeTask,
  failTask,
  killTask,
  evaluateTimeouts,
  filterTasks,
  DEFAULT_TASK_TIMEOUT_MS,
  type TaskWakeEvent,
} from "./task-plane-logic.js";
import {
  classifyCommand,
  type CommandHistoryRecord,
  type ClassificationResult,
} from "./classifier-logic.js";
import { formatPostKillTeachback } from "./teachback-logic.js";
import { reconcileRestartState } from "./recovery-logic.js";
import {
  readTaskRegistry,
  writeTaskRegistry,
  appendTaskOutput,
  readTaskOutput,
  isPidAlive,
  defaultProcessSpawner,
  getDefaultRegistryPath,
  getDefaultOutputDir,
  readRepoShippedState,
  type TaskRegistryReader,
  type TaskRegistryWriter,
  type OutputAppender,
  type OutputReader,
  type PidChecker,
  type ProcessSpawner,
  type SpawnedProcess,
  type ShippedStateReader,
} from "./task-plane-io.js";

export interface OcTaskPlaneConfig {
  defaultTimeoutMs?: number;
  registryPath?: string;
  outputDir?: string;
  supervisorIntervalMs?: number;
}

export interface TaskPlaneIoDependencies {
  reader?: TaskRegistryReader;
  writer?: TaskRegistryWriter;
  appender?: OutputAppender;
  outputReader?: OutputReader;
  pidChecker?: PidChecker;
  spawner?: ProcessSpawner;
  shippedStateReader?: ShippedStateReader;
  now?: () => number;
}

/** Factory to create the plugin definition with optional test dependencies. */
export function createTaskPlanePlugin(deps: TaskPlaneIoDependencies = {}) {
  const reader = deps.reader ?? readTaskRegistry;
  const writer = deps.writer ?? writeTaskRegistry;
  const appender = deps.appender ?? appendTaskOutput;
  const outputReader = deps.outputReader ?? readTaskOutput;
  const pidChecker = deps.pidChecker ?? isPidAlive;
  const spawner = deps.spawner ?? defaultProcessSpawner;
  const shippedStateReader = deps.shippedStateReader ?? readRepoShippedState;
  const getNow = deps.now ?? (() => Date.now());

  let taskCounter = 0;

  return definePluginEntry({
    id: "oc-task-plane",
    name: "OcTaskPlane",
    description: "TaskPlane: lock-free task abstraction with auto-background, wake-on-completion, per-task timeouts, and crash-safe task registry",
    register(api: PluginApi, config?: Record<string, unknown>) {
      const cfg = (config as OcTaskPlaneConfig) ?? {};
      const regPath = cfg.registryPath ?? getDefaultRegistryPath();
      const outputDir = cfg.outputDir ?? getDefaultOutputDir();
      const supervisorIntervalMs = cfg.supervisorIntervalMs ?? 1000;

      let registry: TaskPlaneRegistry = reader(regPath) ?? createRegistry();
      const runningProcesses = new Map<string, SpawnedProcess>();
      const commandHistory: CommandHistoryRecord[] = [];
      let supervisorTimer: NodeJS.Timeout | null = null;

      function persist() {
        try {
          writer(registry, regPath);
        } catch (err) {
          api.logger?.error?.(`[oc-task-plane] Failed to persist registry: ${String(err)}`);
        }
      }

      function handleWake(wake: TaskWakeEvent | { targetSessionKey: string; message: string; taskId: string }) {
        api.logger?.info?.(`[oc-task-plane] Wake dispatched to session ${wake.targetSessionKey} for task ${wake.taskId}`);
      }

      // ── Hook: gateway_start ──────────────────────────────────────────
      api.on("gateway_start", async (_event) => {
        try {
          const persisted = reader(regPath);
          if (persisted) {
            registry = persisted;
          }

          // Gather running task PIDs and probe liveness
          const runningPids: number[] = [];
          for (const task of Object.values(registry.tasks)) {
            if (task.status === "running" && task.pid !== undefined) {
              if (pidChecker(task.pid)) {
                runningPids.push(task.pid);
              }
            }
          }

          // Reconcile restarted state (re-adopt alive PIDs, finalize dead ones)
          const reconciliation = reconcileRestartState(registry, runningPids, { nowMs: getNow() });
          registry = reconciliation.registry;
          persist();

          for (const wake of reconciliation.wakes) {
            handleWake(wake as TaskWakeEvent);
          }

          api.logger?.info?.(
            `[oc-task-plane] Restart reconciliation complete: ${reconciliation.report.readoptedCount} re-adopted, ${reconciliation.report.finalizedDeadCount} finalized.`
          );

          // Start supervisor loop
          supervisorTimer = setInterval(() => {
            const now = getNow();
            const { registry: nextReg, timedOutTasks, wakes } = evaluateTimeouts(registry, { nowMs: now });
            if (timedOutTasks.length > 0) {
              registry = nextReg;
              persist();

              for (const task of timedOutTasks) {
                const proc = runningProcesses.get(task.id);
                if (proc) {
                  try {
                    proc.kill("SIGKILL");
                  } catch {}
                  runningProcesses.delete(task.id);
                }

                // Record teach-back and append to output handle
                const cwd = typeof task.payload?.cwd === "string" ? (task.payload.cwd as string) : undefined;
                const shippedState = shippedStateReader(cwd);
                const { teachback } = formatPostKillTeachback(task, {
                  nowMs: now,
                  shippedState,
                  durationMs: task.timestamps.startedAt ? now - task.timestamps.startedAt : task.timeoutMs,
                });
                appender(
                  task.output_handle,
                  `\n\n[TASK_SUPERVISOR] ${teachback.summary}\n${teachback.detail}\n${teachback.suggestedAction}\n`
                );

                // Record in history for pre-dispatch recall
                const cmd = typeof task.payload?.command === "string" ? task.payload.command : "";
                if (cmd) {
                  commandHistory.push({
                    commandPrefix: cmd.split(" ")[0] || cmd,
                    hitTimeoutCap: true,
                    durationMs: task.timeoutMs,
                    recordedAt: now,
                  });
                }
              }

              for (const wake of wakes) {
                handleWake(wake);
              }
            }
          }, supervisorIntervalMs);
        } catch (err) {
          api.logger?.error?.(`[oc-task-plane] gateway_start failed: ${String(err)}`);
        }
      });

      // ── Hook: gateway_stop ──────────────────────────────────────────
      api.on("gateway_stop", async (_event) => {
        try {
          if (supervisorTimer) {
            clearInterval(supervisorTimer);
            supervisorTimer = null;
          }
          persist();
          api.logger?.info?.("[oc-task-plane] TaskPlane shutdown complete.");
        } catch (err) {
          api.logger?.error?.(`[oc-task-plane] gateway_stop failed: ${String(err)}`);
        }
      });

      // ── Tool: task_dispatch ──────────────────────────────────────────
      api.registerTool({
        name: "task_dispatch",
        description: "Dispatches an asynchronous, lock-free task. Returns immediately with a task ID and output handle without holding execution locks.",
        parameters: Type.Object({
          command: Type.Optional(Type.String({ description: "Shell command to execute for exec tasks" })),
          kind: Type.Optional(Type.String({ description: "Task kind: 'exec', 'subagent', 'wake', or 'cron' (default: 'exec')" })),
          payload: Type.Optional(Type.Any({ description: "Arbitrary payload for the task" })),
          timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds enforced by supervisor" })),
          owner: Type.Optional(Type.String({ description: "Owner session key" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const now = getNow();
            const command = typeof params.command === "string" ? params.command : "";
            const kind = (typeof params.kind === "string" ? params.kind : "exec") as TaskPlaneKind;
            const owner = typeof params.owner === "string" ? params.owner : "session-main";
            const explicitTimeout = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;

            // Pre-dispatch classification check
            const { result: classification }: { result: ClassificationResult } = command
              ? classifyCommand(command, commandHistory, { nowMs: now })
              : { result: { isLongRunner: false, advice: "", recommendation: "foreground" } };

            const effectiveTimeout = explicitTimeout ?? classification.suggestedTimeoutMs ?? cfg.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

            // Generate task ID and output handle
            const taskId = `task-${now}-${++taskCounter}`;
            const outputHandlePath = `${outputDir}/${taskId}.log`;

            const rawPayload = (params.payload && typeof params.payload === "object")
              ? (params.payload as Record<string, unknown>)
              : {};
            const payload = command ? { ...rawPayload, command } : rawPayload;

            // Non-blocking dispatch
            const { registry: nextReg, task } = dispatchTask(
              registry,
              {
                id: taskId,
                kind,
                payload,
                owner,
                timeoutMs: effectiveTimeout,
                output_handle: outputHandlePath,
              },
              { nowMs: now }
            );
            registry = nextReg;
            persist();

            // Asynchronously start execution if exec kind
            if (kind === "exec" && command) {
              const started = startTask(registry, taskId, { nowMs: now });
              registry = started.registry;
              persist();

              const proc = spawner(command, {
                onStdoutChunk(chunk) {
                  appender(outputHandlePath, chunk);
                },
                onStderrChunk(chunk) {
                  appender(outputHandlePath, chunk);
                },
                onExit(code, signal) {
                  const endNow = getNow();
                  runningProcesses.delete(taskId);
                  const tail = outputReader(outputHandlePath, { tailLines: 20 });

                  if (code === 0) {
                    const comp = completeTask(registry, taskId, { exitCode: 0, outputTail: tail }, { nowMs: endNow });
                    registry = comp.registry;
                    persist();
                    if (comp.wake) handleWake(comp.wake);
                  } else {
                    const reason = signal ? `Killed by ${signal}` : `Process exited with code ${code}`;
                    const fail = failTask(registry, taskId, reason, { nowMs: endNow, exitCode: code ?? undefined, outputTail: tail });
                    registry = fail.registry;
                    persist();
                    if (fail.wake) handleWake(fail.wake);
                  }
                },
                onError(err) {
                  const endNow = getNow();
                  runningProcesses.delete(taskId);
                  const fail = failTask(registry, taskId, `Spawn error: ${err.message}`, { nowMs: endNow });
                  registry = fail.registry;
                  persist();
                  if (fail.wake) handleWake(fail.wake);
                },
              });

              runningProcesses.set(taskId, proc);
              if (proc.pid && registry.tasks[taskId]?.status === "running") {
                registry.tasks[taskId].pid = proc.pid;
                persist();
              }
            }

            const response = {
              ok: true,
              taskId: task.id,
              status: task.status,
              kind: task.kind,
              output_handle: task.output_handle,
              timeoutMs: task.timeoutMs,
              classification: classification.isLongRunner
                ? {
                    matched: classification.category,
                    advice: classification.advice,
                  }
                : undefined,
            };

            return {
              content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `task_dispatch failed: ${String(err)}` }],
            };
          }
        },
      });

      // ── Tool: task_status ──────────────────────────────────────────
      api.registerTool({
        name: "task_status",
        description: "Queries the status of tasks in the TaskPlane, including duration, state, and output tails.",
        parameters: Type.Object({
          taskId: Type.Optional(Type.String({ description: "Specific task ID to query" })),
          owner: Type.Optional(Type.String({ description: "Filter tasks by session owner" })),
          status: Type.Optional(Type.String({ description: "Filter tasks by status (queued, running, done, failed, killed)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
            const owner = typeof params.owner === "string" ? params.owner : undefined;
            const status = typeof params.status === "string" ? (params.status as TaskPlaneStatus) : undefined;

            if (taskId) {
              const task = registry.tasks[taskId];
              if (!task) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }],
                };
              }

              const tail = outputReader(task.output_handle, { tailLines: 25 });
              const detail = {
                ok: true,
                task: {
                  ...task,
                  outputTail: tail,
                },
              };

              return {
                content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
              };
            }

            const tasks = filterTasks(registry, { owner, status });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ok: true,
                      count: tasks.length,
                      tasks: tasks.map((t) => ({
                        id: t.id,
                        kind: t.kind,
                        status: t.status,
                        owner: t.owner,
                        queuedAt: t.timestamps.queuedAt,
                        startedAt: t.timestamps.startedAt,
                        completedAt: t.timestamps.completedAt,
                      })),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `task_status failed: ${String(err)}` }],
            };
          }
        },
      });

      // ── Tool: task_output ──────────────────────────────────────────
      api.registerTool({
        name: "task_output",
        description: "Retrieves output from a task's durable output handle (full or tail lines).",
        parameters: Type.Object({
          taskId: Type.String({ description: "Task ID whose output to retrieve" }),
          tailLines: Type.Optional(Type.Number({ description: "Only return the last N lines" })),
          maxBytes: Type.Optional(Type.Number({ description: "Max bytes to return" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.taskId ?? "");
            const task = registry.tasks[taskId];
            if (!task) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }],
              };
            }

            const tailLines = typeof params.tailLines === "number" ? params.tailLines : undefined;
            const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : undefined;
            const output = outputReader(task.output_handle, { tailLines, maxBytes });

            return {
              content: [
                {
                  type: "text" as const,
                  text: output || "(No output recorded yet)",
                },
              ],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `task_output failed: ${String(err)}` }],
            };
          }
        },
      });

      // ── Tool: task_cancel ──────────────────────────────────────────
      api.registerTool({
        name: "task_cancel",
        description: "Cancels or kills a running task. Terminates the underlying process and preserves partial output.",
        parameters: Type.Object({
          taskId: Type.String({ description: "Task ID to cancel" }),
          reason: Type.Optional(Type.String({ description: "Reason for cancellation" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const taskId = String(params.taskId ?? "");
            const task = registry.tasks[taskId];
            if (!task) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }],
              };
            }

            const reason = typeof params.reason === "string" ? params.reason : "Canceled by user/agent request";

            // Signal process termination
            const proc = runningProcesses.get(taskId);
            if (proc) {
              try {
                proc.kill("SIGTERM");
              } catch {}
              runningProcesses.delete(taskId);
            }

            appender(task.output_handle, `\n\n[TASK_CANCEL] ${reason}\n`);
            const tail = outputReader(task.output_handle, { tailLines: 20 });

            const { registry: nextReg, task: updatedTask, wake } = killTask(
              registry,
              taskId,
              reason,
              { nowMs: getNow(), outputTail: tail }
            );
            registry = nextReg;
            persist();

            if (wake) {
              handleWake(wake);
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ok: true,
                      taskId,
                      status: updatedTask?.status,
                      reason,
                      output_handle: task.output_handle,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `task_cancel failed: ${String(err)}` }],
            };
          }
        },
      });
    },
  });
}

export default createTaskPlanePlugin();
