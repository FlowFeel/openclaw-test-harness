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
import {
  defaultGatewayWakeSender,
  formatTaskWakeMessage,
  type GatewayWakeSender,
} from "./task-plane-wake.js";
import { reconcileRestartState } from "./recovery-logic.js";
import {
  validatePipelineSpec,
  decideStepExecution,
  summarizePipelineRun,
  type NormalizedPipelineSpec,
  type PipelineStepResult,
  type StepOutcome,
} from "./exec-pipeline-logic.js";
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
  type DurableSpawner,
  defaultDurableSpawner,
} from "./task-plane-io.js";

export interface OcTaskPlaneConfig {
  defaultTimeoutMs?: number;
  registryPath?: string;
  outputDir?: string;
  supervisorIntervalMs?: number;
  sidecarEndpoint?: string;
}

/**
 * Runs one pipeline step through the injected spawner and awaits its exit.
 * Wiring-layer helper: collects nothing itself — the caller captures stdout/
 * stderr chunks via the callbacks and receives only the exit status here.
 * A per-step timeout kills the process (SIGKILL) and resolves with timedOut.
 */
function runPipelineStep(
  spawner: ProcessSpawner,
  command: string,
  opts: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
): Promise<StepOutcome> {
  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const settle = (outcome: StepOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    const proc = spawner(command, {
      cwd: opts.cwd,
      env: process.env,
      input: opts.input,
      onStdoutChunk: opts.onStdoutChunk,
      onStderrChunk: opts.onStderrChunk,
      onExit: (code) => settle({ exitCode: code, timedOut }),
      onError: (err) => settle({ exitCode: null, timedOut, error: err.message }),
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, opts.timeoutMs);
    }
  });
}

/** Cap per-step captured output embedded in the tool response. */
const STEP_TAIL_CHARS = 800;

function capStepText(text: string): string {
  if (text.length <= STEP_TAIL_CHARS) return text;
  return `${text.slice(0, STEP_TAIL_CHARS)}\n[... ${text.length - STEP_TAIL_CHARS} characters truncated ...]`;
}

export interface TaskPlaneIoDependencies {
  reader?: TaskRegistryReader;
  writer?: TaskRegistryWriter;
  appender?: OutputAppender;
  outputReader?: OutputReader;
  pidChecker?: PidChecker;
  spawner?: ProcessSpawner;
  shippedStateReader?: ShippedStateReader;
  durableSpawner?: DurableSpawner;
  wakeSender?: GatewayWakeSender;
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
  const durableSpawner = deps.durableSpawner ?? defaultDurableSpawner;
  const wakeSender = deps.wakeSender ?? defaultGatewayWakeSender;
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

      async function handleWake(wake: TaskWakeEvent | { targetSessionKey: string; message?: string; taskId: string }) {
        const text = formatTaskWakeMessage(wake);
        api.logger?.info?.(`[oc-task-plane] Wake dispatched to session ${wake.targetSessionKey} for task ${wake.taskId}`);
        try {
          const res = await wakeSender({
            mode: "now",
            sessionKey: wake.targetSessionKey,
            text,
          });
          if (!res.ok) {
            api.logger?.warn?.(`[oc-task-plane] wake RPC returned non-ok for session ${wake.targetSessionKey}: ${res.error ?? "unknown error"}`);
          }
        } catch (err) {
          api.logger?.error?.(`[oc-task-plane] Failed to send wake RPC to ${wake.targetSessionKey}: ${String(err)}`);
        }
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
          kind: Type.Optional(Type.String({ description: "Task kind: 'durable', 'exec', 'subagent', 'wake', or 'cron' (default: 'durable')" })),
          payload: Type.Optional(Type.Any({ description: "Arbitrary payload for the task" })),
          timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds enforced by supervisor" })),
          owner: Type.Optional(Type.String({ description: "Owner session key" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const now = getNow();
            const command = typeof params.command === "string" ? params.command : "";
            const kind = (typeof params.kind === "string" ? params.kind : "durable") as TaskPlaneKind;
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

            let effectiveKind = kind;

            // Durable routing: kind === 'durable' routes to the prime-durable
            // sidecar HTTP API (absurd-backed, checkpointed steps in Postgres).
            // When sidecar is unavailable and a command is present, falls back cleanly to local exec.
            if (effectiveKind === "durable") {
              const payloadObj = (payload && typeof payload === "object")
                ? (payload as Record<string, unknown>)
                : {};
              const durableTaskName = typeof payloadObj.task_name === "string"
                ? String(payloadObj.task_name)
                : "agent_step";
              const durableParams = typeof payloadObj.params === "object" && payloadObj.params !== null
                ? (payloadObj.params as Record<string, unknown>)
                : { prompt: command };
              const notify = typeof payloadObj.notify === "object" && payloadObj.notify !== null
                ? (payloadObj.notify as Record<string, unknown>)
                : undefined;

              try {
                const spawnResult = await durableSpawner(
                  {
                    task_name: durableTaskName,
                    params: durableParams,
                    queue: "default",
                    ...(notify ? { notify } : {}),
                  },
                  { endpoint: cfg.sidecarEndpoint },
                );

                if (spawnResult.ok && spawnResult.task_id) {
                  // Mark task as running in the task-plane registry
                  const started = startTask(registry, taskId, { nowMs: now });
                  registry = started.registry;
                  if (registry.tasks[taskId]) {
                    registry.tasks[taskId].payload = {
                      ...registry.tasks[taskId].payload,
                      durable_task_id: spawnResult.task_id,
                    };
                  }
                  appender(outputHandlePath, `[oc-task-plane] durable task spawned in absurd: ${spawnResult.task_id}\n`);
                  persist();

                  return {
                    content: [{
                      type: "text" as const,
                      text: JSON.stringify({
                        ok: true,
                        taskId: task.id,
                        durable_task_id: spawnResult.task_id,
                        status: "running",
                        kind: "durable",
                        output_handle: outputHandlePath,
                      }, null, 2),
                    }],
                  };
                }

                // If sidecar returned non-ok, fall back to exec if command available
                api.logger?.warn?.(
                  `[oc-task-plane] durable spawn failed (${spawnResult.status}: ${spawnResult.error}), falling back to exec`,
                );
                if (command) {
                  effectiveKind = "exec";
                }
              } catch (durableErr) {
                api.logger?.warn?.(
                  `[oc-task-plane] sidecar unreachable, falling back to exec: ${String(durableErr)}`,
                );
                if (command) {
                  effectiveKind = "exec";
                }
              }
            }

            // Asynchronously start execution if exec kind (either direct or fallback from durable)
            if (effectiveKind === "exec" && command) {
              const started = startTask(registry, taskId, { nowMs: now });
              registry = started.registry;
              if (registry.tasks[taskId]) {
                registry.tasks[taskId].kind = "exec";
              }
              persist();

              const proc = spawner(command, {
                cwd: outputDir,
                env: process.env,
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

            const currentTask = registry.tasks[taskId] ?? task;
            const response = {
              ok: true,
              taskId: task.id,
              status: currentTask.status,
              kind: currentTask.kind,
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

      // ── Tool: exec_pipeline (T-583) ─────────────────────────────────
      // Multi-command pipeline with a pure logic seam: validation, per-step
      // conditional decisions, and run summarization live in
      // exec-pipeline-logic.ts; this wiring only spawns processes through the
      // I/O Protocol and records results into the task registry.
      api.registerTool({
        name: "exec_pipeline",
        description:
          "Runs an ordered pipeline of shell commands with sequential or piped " +
          "data flow and per-step conditionals. In 'sequential' mode each step's " +
          "output is captured separately; in 'piped' mode each step's stdout is " +
          "fed into the next step's stdin. Conditions: 'always' (default), " +
          "'on_success' (run only if the previous step succeeded, like &&), " +
          "'on_failure' (run only if the previous step failed, like ||). " +
          "Returns a per-step report and records the run as a TaskPlane task.",
        parameters: Type.Object({
          steps: Type.Array(
            Type.Object({
              command: Type.String({ description: "Shell command to run for this step" }),
              condition: Type.Optional(Type.String({ description: "'always' (default), 'on_success', or 'on_failure' relative to the previous step's exit code" })),
            }),
            { description: "Ordered pipeline steps (minimum 1)" },
          ),
          mode: Type.Optional(Type.String({ description: "'sequential' (default) captures each step's output separately; 'piped' feeds each step's stdout into the next step's stdin" })),
          stopOnFailure: Type.Optional(Type.Boolean({ description: "Skip all later steps after a failed step (default true)" })),
          stepTimeoutMs: Type.Optional(Type.Number({ description: "Per-step timeout in milliseconds; the step process is killed on expiry" })),
          cwd: Type.Optional(Type.String({ description: "Working directory for the pipeline steps" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const now = getNow();
            const validation = validatePipelineSpec({
              steps: params.steps,
              mode: params.mode,
              stopOnFailure: params.stopOnFailure,
            });
            if (!validation.ok) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ ok: false, error: validation.error }, null, 2),
                }],
              };
            }
            const spec: NormalizedPipelineSpec = validation.spec;
            const stepTimeoutMs =
              typeof params.stepTimeoutMs === "number" && params.stepTimeoutMs > 0
                ? params.stepTimeoutMs
                : undefined;
            const cwd = typeof params.cwd === "string" ? params.cwd : outputDir;

            // Record the pipeline run as a TaskPlane task for observability.
            const taskId = `pipeline-${now}-${++taskCounter}`;
            const outputHandlePath = `${outputDir}/${taskId}.log`;
            const dispatched = dispatchTask(
              registry,
              {
                id: taskId,
                kind: "exec",
                payload: { pipeline: spec },
                owner: "session-main",
                output_handle: outputHandlePath,
              },
              { nowMs: now },
            );
            registry = dispatched.registry;
            const started = startTask(registry, taskId, { nowMs: getNow() });
            registry = started.registry;
            persist();
            appender(
              outputHandlePath,
              `[oc-task-plane] exec_pipeline: ${spec.steps.length} step(s), mode=${spec.mode}, stopOnFailure=${spec.stopOnFailure}\n`,
            );

            const results: PipelineStepResult[] = [];
            let previous: StepOutcome | null = null;
            let aborted = false;
            let previousInputTail = "";
            const stepOutputs = new Map<number, { stdout: string; stderr: string }>();

            for (let i = 0; i < spec.steps.length; i++) {
              const step = spec.steps[i];
              const decision = decideStepExecution(step.condition, previous);
              if (!decision.run) {
                results.push({
                  index: i,
                  command: step.command,
                  executed: false,
                  skipped: true,
                  skipReason: decision.reason,
                });
                continue;
              }
              if (aborted) {
                results.push({
                  index: i,
                  command: step.command,
                  executed: false,
                  skipped: true,
                  skipReason: "skipped: earlier step failed (stopOnFailure)",
                });
                continue;
              }

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              const input =
                spec.mode === "piped" && previous ? previousInputTail : undefined;
              const outcome = await runPipelineStep(spawner, step.command, {
                cwd,
                input,
                timeoutMs: stepTimeoutMs,
                onStdoutChunk: (chunk) => {
                  stdoutChunks.push(chunk);
                  appender(outputHandlePath, chunk);
                },
                onStderrChunk: (chunk) => {
                  stderrChunks.push(chunk);
                  appender(outputHandlePath, chunk);
                },
              });
              const stdout = stdoutChunks.join("");
              const stderr = stderrChunks.join("");
              previous = outcome;
              previousInputTail = stdout;

              results.push({
                index: i,
                command: step.command,
                executed: true,
                exitCode: outcome.exitCode,
                timedOut: outcome.timedOut,
                error: outcome.error,
              });
              stepOutputs.set(i, { stdout, stderr });

              const failed =
                outcome.error !== undefined ||
                outcome.timedOut === true ||
                (outcome.exitCode ?? 1) !== 0;
              if (failed && spec.stopOnFailure) {
                aborted = true;
              }
            }

            const summary = summarizePipelineRun(spec, results);
            const tail = outputReader(outputHandlePath, { tailLines: 20 });

            if (summary.ok) {
              const comp = completeTask(
                registry,
                taskId,
                { exitCode: 0, outputTail: tail },
                { nowMs: getNow() },
              );
              registry = comp.registry;
              persist();
              if (comp.wake) handleWake(comp.wake);
            } else {
              const reason = summary.failedStepIndex !== null
                ? `Pipeline failed at step ${summary.failedStepIndex}: ${spec.steps[summary.failedStepIndex]?.command ?? ""}`
                : "Pipeline failed";
              const fail = failTask(registry, taskId, reason, {
                nowMs: getNow(),
                exitCode: summary.finalExitCode ?? undefined,
                outputTail: tail,
              });
              registry = fail.registry;
              persist();
              if (fail.wake) handleWake(fail.wake);
            }

            const stepReports = results.map((r) => {
              const out = stepOutputs.get(r.index);
              return {
                ...r,
                stdoutTail: out ? capStepText(out.stdout) : undefined,
                stderrTail: out ? capStepText(out.stderr) : undefined,
              };
            });

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  ok: summary.ok,
                  taskId,
                  output_handle: outputHandlePath,
                  report: summary,
                  steps: stepReports,
                }, null, 2),
              }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `exec_pipeline failed: ${String(err)}` }],
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
