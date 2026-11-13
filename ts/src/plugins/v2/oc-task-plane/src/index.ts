/**
 * Unified Task Plane Engine — Plugins v2 Core Entry Point.
 *
 * @behavior
 * Consolidates lock-free asynchronous task execution, durable Postgres sidecar proxying,
 * multi-step unix pipeline chaining, staging revision verification, subagent work
 * queueing, adaptive admission, and watchdog lifecycle tracking into a single unified engine.
 *
 * Absorbs:
 * - oc-task-plane
 * - oc-durable-sidecar
 * - oc-subagent-orchestrator
 * - oc-subagent-watchdog
 *
 * @invariants
 * - Pure logic / IO separation: all pure logic modules in *-logic.ts.
 * - Strict determinism: all time injected via parameters or clock provider.
 * - Conforms bidirectionally to openclaw.plugin.json contracts.
 * - Real protocol doubles supported via dependency injection.
 *
 * @dft
 * - Tested with in-memory test doubles and real containerized E2E runs.
 */

import { definePluginEntry, Type, type PluginApi } from "../../../shared/types.js";
import type {
  TaskPlaneRegistry,
  TaskPlaneTask,
  TaskPlaneKind,
  TaskPlaneStatus,
} from "../../../shared/types.js";

// ── Task Plane Seams ────────────────────────────────────────────────
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
  readRepoShippedState,
  getDefaultRegistryPath,
  getDefaultOutputDir,
  type TaskRegistryReader,
  type TaskRegistryWriter,
  type OutputAppender,
  type OutputReader,
  type PidChecker,
  type ShippedStateReader,
  type ProcessSpawner,
  type SpawnedProcess,
  type DurableSpawner,
  defaultDurableSpawner,
} from "./task-plane-io.js";

// ── Staging Verify Seams ────────────────────────────────────────────
import { evaluateRevisionMatch } from "./staging-verify-logic.js";
import {
  defaultFetchStagingRevision,
  type RevisionFetcher,
} from "./staging-verify-io.js";

// ── Durable Sidecar Seams ───────────────────────────────────────────
import {
  SIDECAR_BASE_URL,
  buildListRequest,
  buildResultRequest,
  buildRetryRequest,
  buildSpawnRequest,
  buildStatusRequest,
  buildTasksRequest,
  buildWaitRequest,
  interpret,
  interpretTransportFailure,
  type ListFilters,
  type NotifySpec,
  type SidecarRequest,
} from "./durable-sidecar-logic.js";
import { makeHttpFetchJson, type FetchJson } from "./durable-sidecar-io.js";

// ── Subagent Orchestration & Watchdog Seams ─────────────────────────
import {
  createQueue,
  dispatchNext,
  recordResult,
  failBlockedTasks,
  getResultsInOrder,
  computeProgress,
  isComplete,
  computeEffectiveMaxConcurrent,
  type WorkQueueState,
  type TaskSpec,
} from "../../../shared/work-queue-scheduler.js";
import {
  mergeResults,
  formatMergedDocument,
  type SubagentResult,
} from "../../../shared/result-merger.js";
import {
  trackSpawn,
  trackEnd,
  detectStale,
  getActiveCount,
  canSpawn,
  type SubagentMap,
} from "./subagent-tracker.js";

export interface TaskPlaneConfig {
  registryPath?: string;
  outputDir?: string;
  defaultTimeoutMs?: number;
  supervisorIntervalMs?: number;
  sidecarBaseUrl?: string;
  sidecarTimeoutMs?: number;
  maxConcurrentSubagents?: number;
  subagentTimeoutSeconds?: number;
  gatewayWakeSender?: GatewayWakeSender;
  fetchStagingRevision?: RevisionFetcher;
  fetchJson?: FetchJson;
}

function text(outcome: { verdict: string; summary: string; detail?: Record<string, unknown> }) {
  return {
    content: [{ type: "text" as const, text: `${outcome.verdict}: ${outcome.summary}` }],
  };
}

export default definePluginEntry({
  id: "oc-task-plane",
  name: "OC Task Plane",
  description: "Unified Task Plane Engine (Plugins v2) — consolidates lock-free async dispatch, multi-step pipeline execution, staging verification, durable postgres sidecar proxying, subagent work queueing, and watchdog lifecycle tracking.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as TaskPlaneConfig) ?? {};
    const defaultTimeoutMs = cfg.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const supervisorIntervalMs = cfg.supervisorIntervalMs ?? 1000;
    const sidecarBaseUrl = cfg.sidecarBaseUrl ?? SIDECAR_BASE_URL;
    const sidecarTimeoutMs = cfg.sidecarTimeoutMs ?? 180000;
    const maxConcurrentSubagents = cfg.maxConcurrentSubagents ?? 6;
    const subagentTimeoutSeconds = cfg.subagentTimeoutSeconds ?? 300;

    const regPath = cfg.registryPath ?? getDefaultRegistryPath();
    const outputDir = cfg.outputDir ?? getDefaultOutputDir();

    const reader: TaskRegistryReader = readTaskRegistry;
    const writer: TaskRegistryWriter = writeTaskRegistry;
    const appender: OutputAppender = appendTaskOutput;
    const outputReader: OutputReader = readTaskOutput;
    const pidChecker: PidChecker = isPidAlive;
    const spawner: ProcessSpawner = defaultProcessSpawner;
    const shippedStateReader: ShippedStateReader = readRepoShippedState;
    const durableSpawner: DurableSpawner = defaultDurableSpawner;

    const wakeSender: GatewayWakeSender = cfg.gatewayWakeSender ?? defaultGatewayWakeSender;
    const revisionFetcher: RevisionFetcher = cfg.fetchStagingRevision ?? defaultFetchStagingRevision;
    const fetchJson: FetchJson = cfg.fetchJson ?? makeHttpFetchJson(sidecarBaseUrl);

    // In-Memory Task & Subagent Registries
    let registry: TaskPlaneRegistry = reader(regPath) ?? createRegistry();
    let supervisorTimer: NodeJS.Timeout | null = null;
    const runningProcesses = new Map<string, SpawnedProcess>();
    const commandHistory: CommandHistoryRecord[] = [];
    const subagents: SubagentMap = new Map();
    let workQueue: WorkQueueState | null = null;
    let originalSpecs: TaskSpec[] = [];
    let taskCounter = 0;

    function persist() {
      writer(registry, regPath);
    }

    function handleWake(wake: TaskWakeEvent) {
      const msg = formatTaskWakeMessage(wake);
      wakeSender({
        sessionKey: wake.targetSessionKey,
        mode: "next-heartbeat",
        text: msg,
      }).catch((err) => {
        api.logger?.warn?.(`[oc-task-plane] wake dispatch failed: ${String(err)}`);
      });
    }

    // Helper: Execute Durable Sidecar Request
    async function executeDurable(req: SidecarRequest) {
      try {
        const response = await fetchJson(req, sidecarTimeoutMs);
        const outcome = interpret(response);
        return text(outcome);
      } catch (err) {
        const outcome = interpretTransportFailure(err);
        return text(outcome);
      }
    }

    // ── Gateway Lifecycle Hooks ─────────────────────────────────────
    api.on("gateway_start", async () => {
      try {
        const diskRegistry = reader(regPath);
        if (diskRegistry) {
          const runningPids: number[] = [];
          for (const task of Object.values(diskRegistry.tasks)) {
            if (task.status === "running" && task.pid !== undefined) {
              if (pidChecker(task.pid)) {
                runningPids.push(task.pid);
              }
            }
          }

          const reconciliation = reconcileRestartState(diskRegistry, runningPids, { nowMs: Date.now() });
          registry = reconciliation.registry;
          persist();

          for (const wake of reconciliation.wakes) {
            handleWake(wake as TaskWakeEvent);
          }
        }

        supervisorTimer = setInterval(() => {
          const now = Date.now();
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
            }

            for (const wake of wakes) {
              handleWake(wake as TaskWakeEvent);
            }
          }
        }, supervisorIntervalMs);
      } catch (err) {
        api.logger?.error?.(`[oc-task-plane] gateway_start error: ${String(err)}`);
      }
    });

    api.on("gateway_stop", async () => {
      if (supervisorTimer) {
        clearInterval(supervisorTimer);
        supervisorTimer = null;
      }
      persist();
    });

    // ── Tool 1: task_dispatch ───────────────────────────────────────
    api.registerTool({
      name: "task_dispatch",
      description: "Dispatches an asynchronous, lock-free task. Returns immediately with a task ID and output handle without holding execution locks.",
      parameters: Type.Object({
        command: Type.Optional(Type.String({ description: "Shell command to execute for exec tasks" })),
        kind: Type.Optional(Type.String({ description: "Task kind: 'durable', 'exec', 'subagent', 'wake', or 'cron' (default: 'durable')" })),
        owner: Type.Optional(Type.String({ description: "Owner session key" })),
        timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds enforced by supervisor" })),
        payload: Type.Optional(Type.Any({ description: "Arbitrary payload for the task" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const now = Date.now();
          const command = typeof params.command === "string" ? params.command : "";
          const kind = (typeof params.kind === "string" ? params.kind : "durable") as TaskPlaneKind;
          const owner = typeof params.owner === "string" ? params.owner : "session-main";
          const explicitTimeout = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;

          const { result: classification }: { result: ClassificationResult } = command
            ? classifyCommand(command, commandHistory, { nowMs: now })
            : { result: { isLongRunner: false, advice: "", recommendation: "foreground" } };

          const effectiveTimeout = explicitTimeout ?? classification.suggestedTimeoutMs ?? defaultTimeoutMs;
          const taskId = `task-${now}-${++taskCounter}`;
          const outputHandlePath = `${outputDir}/${taskId}.log`;

          const rawPayload = (params.payload && typeof params.payload === "object")
            ? (params.payload as Record<string, unknown>)
            : {};
          const payload = command ? { ...rawPayload, command } : rawPayload;

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

          if (kind === "exec" && command) {
            const spawned = spawner(command, {
              cwd: typeof payload.cwd === "string" ? (payload.cwd as string) : undefined,
              onStdoutChunk: (chunk: string) => appender(outputHandlePath, chunk),
              onStderrChunk: (chunk: string) => appender(outputHandlePath, chunk),
              onExit: (exitCode: number | null) => {
                const completeNow = Date.now();
                runningProcesses.delete(taskId);
                const { registry: doneReg, wake } = completeTask(
                  registry,
                  taskId,
                  { exitCode: exitCode ?? undefined },
                  { nowMs: completeNow }
                );
                registry = doneReg;
                persist();
                if (wake) handleWake(wake);
              },
            });
            runningProcesses.set(taskId, spawned);
            const { registry: runningReg } = startTask(registry, taskId, { nowMs: now, pid: spawned.pid });
            registry = runningReg;
            persist();
          }

          const currentTask = registry.tasks[taskId] ?? task;

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                taskId: task.id,
                status: currentTask.status,
                kind: currentTask.kind,
                output_handle: task.output_handle,
                timeoutMs: task.timeoutMs,
              }, null, 2),
            }],
          };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `task_dispatch error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 2: task_status ─────────────────────────────────────────
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
            if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }] };
            const tail = outputReader(task.output_handle, { tailLines: 25 });
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task: { ...task, outputTail: tail } }, null, 2) }] };
          }

          const tasks = filterTasks(registry, { owner, status });
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: tasks.length, tasks }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `task_status error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 3: task_output ─────────────────────────────────────────
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
          if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }] };

          const tailLines = typeof params.tailLines === "number" ? params.tailLines : undefined;
          const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : undefined;
          const output = outputReader(task.output_handle, { tailLines, maxBytes });
          return { content: [{ type: "text" as const, text: output || "(No output recorded yet)" }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `task_output error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 4: task_cancel ─────────────────────────────────────────
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
          if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `Task '${taskId}' not found.` }) }] };

          const reason = typeof params.reason === "string" ? params.reason : "Canceled by user/agent request";
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
            { nowMs: Date.now(), outputTail: tail }
          );
          registry = nextReg;
          persist();

          if (wake) handleWake(wake as TaskWakeEvent);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, taskId, status: updatedTask?.status, reason }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `task_cancel error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 5: exec_pipeline ───────────────────────────────────────
    api.registerTool({
      name: "exec_pipeline",
      description: "Runs an ordered pipeline of shell commands with sequential or piped data flow and per-step conditionals.",
      parameters: Type.Object({
        steps: Type.Array(Type.Object({
          command: Type.String({ description: "Shell command to run for this step" }),
          condition: Type.Optional(Type.String({ description: "'always' (default), 'on_success', or 'on_failure'" })),
        })),
        mode: Type.Optional(Type.String({ description: "'sequential' (default) captures output separately; 'piped' feeds stdout to stdin" })),
        stopOnFailure: Type.Optional(Type.Boolean({ description: "Skip all later steps after a failed step (default true)" })),
        cwd: Type.Optional(Type.String({ description: "Working directory for the pipeline steps" })),
        stepTimeoutMs: Type.Optional(Type.Number({ description: "Per-step timeout in milliseconds" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const validated = validatePipelineSpec(params);
          if (!validated.ok) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: validated.error }) }] };
          }
          const spec: NormalizedPipelineSpec = validated.spec;
          const pipelineCwd = typeof params.cwd === "string" ? params.cwd : undefined;
          const taskId = `task-pipe-${Date.now()}-${++taskCounter}`;
          const outputHandlePath = `${outputDir}/${taskId}.log`;

          const dispatched = dispatchTask(
            registry,
            { id: taskId, kind: "exec", owner: "session-main", payload: { pipeline: true, mode: spec.mode, stepCount: spec.steps.length, cwd: pipelineCwd }, timeoutMs: defaultTimeoutMs, output_handle: outputHandlePath },
            { nowMs: Date.now() }
          );
          registry = dispatched.registry;
          persist();

          const results: PipelineStepResult[] = [];
          let previous: StepOutcome | null = null;
          let aborted = false;

          for (let i = 0; i < spec.steps.length; i++) {
            const step = spec.steps[i];
            const decision = decideStepExecution(step.condition, previous);
            if (!decision.run || aborted) {
              results.push({ index: i, command: step.command, executed: false, skipped: true, skipReason: decision.reason });
              continue;
            }

            const stdoutChunks: string[] = [];
            const exitCode = await new Promise<number>((res) => {
              spawner(step.command, {
                cwd: pipelineCwd,
                onStdoutChunk: (c: string) => { stdoutChunks.push(c); appender(outputHandlePath, c); },
                onStderrChunk: (c: string) => appender(outputHandlePath, c),
                onExit: (code: number | null) => res(code ?? 0),
                onError: () => res(1),
              });
            });

            const outcome: StepOutcome = { exitCode, timedOut: false };
            previous = outcome;
            results.push({ index: i, command: step.command, executed: true, exitCode });
            if (exitCode !== 0 && spec.stopOnFailure) aborted = true;
          }

          const summary = summarizePipelineRun(spec, results);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: summary.ok, taskId, report: summary, steps: results }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `exec_pipeline error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 6: staging_verify ──────────────────────────────────────
    api.registerTool({
      name: "staging_verify",
      description: "Verify that a staging deployment endpoint is actively serving the expected git commit SHA rather than a stale container bake.",
      parameters: Type.Object({
        url: Type.String({ description: "Staging revision endpoint (e.g. /Special:Version, version.json, siteinfo)" }),
        expectedSha: Type.String({ description: "Target git commit SHA that was deployed" }),
        timeoutMs: Type.Optional(Type.Number({ description: "HTTP timeout in milliseconds (default: 10000)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const url = String(params.url ?? "");
          const expectedSha = String(params.expectedSha ?? "");
          const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;

          const res = await revisionFetcher(url, timeoutMs);
          if (!res.ok) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ verified: false, status: "fetch_failed", expectedSha, error: res.error || `HTTP ${res.status}` }, null, 2),
              }],
            };
          }

          const verdict = evaluateRevisionMatch(res.payload, expectedSha);
          return { content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `staging_verify error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 7: subagent_health ─────────────────────────────────────
    api.registerTool({
      name: "subagent_health",
      description: "Check subagent health — active count, stale detection, spawn availability. Run before spawning subagents to check capacity.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const now = Date.now();
        const { stale } = detectStale(subagents, subagentTimeoutSeconds, now);
        const activeCount = getActiveCount(subagents);
        const spawnAvailable = canSpawn(subagents, maxConcurrentSubagents);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              activeCount,
              maxConcurrent: maxConcurrentSubagents,
              spawnAvailable,
              staleSubagents: Array.from(stale.values()).map((s) => ({
                id: s.sessionKey,
                spawnedBy: s.spawnedBy,
                elapsedSeconds: Math.round((now - s.startedAtMs) / 1000),
                timeoutSeconds: subagentTimeoutSeconds,
              })),
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool 8: queue_work ──────────────────────────────────────────
    api.registerTool({
      name: "queue_work",
      description: "Queue a batch of subagent tasks for parallel dispatch. Tasks are dispatched across maxConcurrent slots, respecting dependencies and priority. Returns the number of tasks dispatched.",
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          priority: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const tasks = (params.tasks ?? []) as TaskSpec[];
        workQueue = createQueue(tasks);
        originalSpecs = tasks;
        const effectiveMax = computeEffectiveMaxConcurrent(maxConcurrentSubagents, "healthy");
        const { taskIds, state: nextQ } = dispatchNext(workQueue, effectiveMax, Date.now());
        workQueue = nextQ;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              queued: workQueue.tasks.size,
              dispatched: taskIds.length,
              effectiveMaxConcurrent: effectiveMax,
              tasksDispatched: taskIds,
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool 9: queue_status ────────────────────────────────────────
    api.registerTool({
      name: "queue_status",
      description: "Check the status of the subagent work queue — total/queued/dispatched/completed/failed counts, active slots, effective maxConcurrent, and health status.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        if (!workQueue) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, queueActive: false, message: "No active work queue" }, null, 2) }] };
        }
        const effectiveMax = computeEffectiveMaxConcurrent(maxConcurrentSubagents, "healthy");
        const progress = computeProgress(workQueue, effectiveMax);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, queueActive: true, ...progress }, null, 2) }] };
      },
    });

    // ── Tool 10: queue_results ──────────────────────────────────────
    api.registerTool({
      name: "queue_results",
      description: "Get results from the work queue in original task order. Incomplete tasks have undefined results. Pass merge=true to merge and deduplicate results.",
      parameters: Type.Object({
        merge: Type.Optional(Type.Boolean({ description: "If true, merge and deduplicate results" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!workQueue) return { content: [{ type: "text" as const, text: "No active work queue" }] };
        const results = getResultsInOrder(workQueue, originalSpecs);

        if (params.merge === true) {
          const subagentResults: SubagentResult[] = results
            .filter((r) => r.result !== undefined)
            .map((r) => ({
              taskId: r.spec.id,
              taskType: "search",
              findings: [],
              citations: Array.isArray(r.result) ? (r.result as any[]) : [],
            }));
          if (subagentResults.length > 0) {
            const { merged, report } = mergeResults(subagentResults);
            return { content: [{ type: "text" as const, text: formatMergedDocument(merged) + "\n\n---\n" + JSON.stringify(report, null, 2) }] };
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(results.map((r) => ({ id: r.spec.id, status: r.status, hasResult: r.result !== undefined })), null, 2) }] };
      },
    });

    // ── Tool 11: merge_results ──────────────────────────────────────
    api.registerTool({
      name: "merge_results",
      description: "Merge multiple subagent results into a single document with deduplication by citation key (DOI/URL), relevance sorting, and per-source attribution.",
      parameters: Type.Object({
        results: Type.Array(Type.Any({ description: "Array of subagent results to merge" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const input = (params.results ?? []) as SubagentResult[];
        const { merged, report } = mergeResults(input);
        return { content: [{ type: "text" as const, text: formatMergedDocument(merged) + "\n\n---\n" + JSON.stringify(report, null, 2) }] };
      },
    });

    // ── Tool 12: durable_spawn ──────────────────────────────────────
    api.registerTool({
      name: "durable_spawn",
      description: "Spawn a durable task via prime-durable sidecar.",
      parameters: Type.Object({
        task_name: Type.String(),
        params: Type.Optional(Type.Any()),
        queue: Type.Optional(Type.String()),
        notify: Type.Optional(Type.Any()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const rawParams = params.params && typeof params.params === "object"
          ? (params.params as Record<string, unknown>)
          : {};
        const req = buildSpawnRequest(
          String(params.task_name ?? ""),
          rawParams,
          typeof params.queue === "string" ? params.queue : undefined,
          params.notify as NotifySpec | undefined,
        );
        return executeDurable(req);
      },
    });

    // ── Tool 13: durable_status ─────────────────────────────────────
    api.registerTool({
      name: "durable_status",
      description: "Poll status of a durable task via prime-durable sidecar.",
      parameters: Type.Object({
        job_id: Type.Optional(Type.Number()),
      }),
      async execute(_id: string) {
        const req = buildStatusRequest();
        return executeDurable(req);
      },
    });

    // ── Tool 14: durable_result ─────────────────────────────────────
    api.registerTool({
      name: "durable_result",
      description: "Fetch result of a finished durable task via prime-durable sidecar.",
      parameters: Type.Object({
        task_id: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const req = buildResultRequest(String(params.task_id ?? "0"));
        return executeDurable(req);
      },
    });

    // ── Tool 15: durable_wait ───────────────────────────────────────
    api.registerTool({
      name: "durable_wait",
      description: "Wait for a durable task to finish via prime-durable sidecar.",
      parameters: Type.Object({
        task_id: Type.String(),
        timeout_seconds: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const req = buildWaitRequest(
          String(params.task_id ?? "0"),
          typeof params.timeout_seconds === "number" ? params.timeout_seconds : 120,
        );
        return executeDurable(req);
      },
    });

    // ── Tool 16: durable_retry ──────────────────────────────────────
    api.registerTool({
      name: "durable_retry",
      description: "Retry a failed or cancelled durable task via prime-durable sidecar.",
      parameters: Type.Object({
        task_id: Type.String(),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const req = buildRetryRequest(String(params.task_id ?? "0"));
        return executeDurable(req);
      },
    });

    // ── Tool 17: durable_tasks ──────────────────────────────────────
    api.registerTool({
      name: "durable_tasks",
      description: "List registered task names known to prime-durable sidecar.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const req = buildTasksRequest();
        return executeDurable(req);
      },
    });

    // ── Tool 18: durable_list ───────────────────────────────────────
    api.registerTool({
      name: "durable_list",
      description: "List recent jobs in prime-durable sidecar.",
      parameters: Type.Object({
        queue: Type.Optional(Type.String()),
        task_name: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const req = buildListRequest(params as ListFilters);
        return executeDurable(req);
      },
    });
  },
});
