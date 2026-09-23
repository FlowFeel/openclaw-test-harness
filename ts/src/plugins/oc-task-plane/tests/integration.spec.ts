/**
 * Integration tests for OcTaskPlane plugin.
 *
 * @dft
 * - Uses in-memory Protocol doubles (Axiom 5), no vi.fn() patch-overs.
 * - Exercises tool dispatch, status, output, cancel, and gateway lifecycle hooks.
 */

import { describe, it, expect } from "vitest";
import { createTaskPlanePlugin } from "../src/index.js";
import type {
  TaskRegistryReader,
  TaskRegistryWriter,
  OutputAppender,
  OutputReader,
  ProcessSpawner,
  SpawnedProcess,
} from "../src/task-plane-io.js";
import type {
  PluginApi,
  ToolDefinition,
  HookEvent,
  HookContext,
  TaskPlaneRegistry,
} from "../../shared/types.js";
import { createRegistry } from "../src/task-plane-logic.js";

/** Real in-memory Protocol double adhering to Axiom 5 */
class InMemoryTaskStore {
  public registry: TaskPlaneRegistry = createRegistry();
  public outputs = new Map<string, string>();
  public activePids = new Set<number>();
  public spawnedCommands: string[] = [];

  readonly reader: TaskRegistryReader = () => {
    return JSON.parse(JSON.stringify(this.registry));
  };

  readonly writer: TaskRegistryWriter = (data) => {
    this.registry = JSON.parse(JSON.stringify(data));
  };

  readonly appender: OutputAppender = (handle, chunk) => {
    const prev = this.outputs.get(handle) ?? "";
    this.outputs.set(handle, prev + chunk);
  };

  readonly outputReader: OutputReader = (handle, opts) => {
    const raw = this.outputs.get(handle) ?? "";
    if (opts?.tailLines) {
      const hasTrailingNewline = raw.endsWith("\n");
      const content = hasTrailingNewline ? raw.slice(0, -1) : raw;
      const lines = content.split("\n");
      return lines.slice(-opts.tailLines).join("\n") + (hasTrailingNewline ? "\n" : "");
    }
    return raw;
  };

  readonly pidChecker = (pid: number): boolean => {
    return this.activePids.has(pid);
  };

  createSpawner(autoExitCode: number = 0, outputText: string = "Process completed successfully.\n"): ProcessSpawner {
    return (command, opts) => {
      this.spawnedCommands.push(command);
      const pid = 9001;

      // Simulate output and exit
      if (opts.onStdoutChunk) {
        opts.onStdoutChunk(outputText);
      }
      if (opts.onExit) {
        opts.onExit(autoExitCode, null);
      }

      const proc: SpawnedProcess = {
        pid,
        kill: (_sig) => {},
      };
      return proc;
    };
  }
}

function createMockPluginApi() {
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, (event: HookEvent, ctx?: HookContext) => Promise<unknown> | unknown>();
  const logs: string[] = [];

  const api: PluginApi = {
    logger: {
      info: (msg) => logs.push(`INFO: ${msg}`),
      error: (msg) => logs.push(`ERROR: ${msg}`),
      warn: (msg) => logs.push(`WARN: ${msg}`),
    },
    on: (name, handler) => {
      hooks.set(name, handler);
    },
    registerHook: (events, handler) => {
      const names = Array.isArray(events) ? events : [events];
      for (const n of names) hooks.set(n, handler);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  };

  return { api, tools, hooks, logs };
}

describe("oc-task-plane integration", () => {
  it("registers all four tools and two lifecycle hooks", () => {
    const store = new InMemoryTaskStore();
    const plugin = createTaskPlanePlugin({
      reader: store.reader,
      writer: store.writer,
      appender: store.appender,
      outputReader: store.outputReader,
    });

    const { api, tools, hooks } = createMockPluginApi();
    plugin.register(api);

    expect(tools.has("task_dispatch")).toBe(true);
    expect(tools.has("task_status")).toBe(true);
    expect(tools.has("task_output")).toBe(true);
    expect(tools.has("task_cancel")).toBe(true);

    expect(hooks.has("gateway_start")).toBe(true);
    expect(hooks.has("gateway_stop")).toBe(true);
  });

  it("dispatches async tasks and captures outputs via task_dispatch, task_status, task_output", async () => {
    const store = new InMemoryTaskStore();
    const simTime = 1000;
    const plugin = createTaskPlanePlugin({
      reader: store.reader,
      writer: store.writer,
      appender: store.appender,
      outputReader: store.outputReader,
      spawner: store.createSpawner(0, "Line 1: Building\nLine 2: Ready\n"),
      now: () => simTime,
    });

    const { api, tools } = createMockPluginApi();
    plugin.register(api);

    const dispatchTool = tools.get("task_dispatch")!;
    const res = await dispatchTool.execute("call-1", {
      command: "docker build -t test .",
      owner: "session-42",
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeDefined();
    expect(body.classification?.matched).toBe("docker");
    expect(body.classification?.advice).toContain("Docker build");

    const taskId = body.taskId;

    // 2. Inspect output via task_output
    const outputTool = tools.get("task_output")!;
    const outputRes = await outputTool.execute("call-2", { taskId });
    expect(outputRes.content[0].text).toContain("Line 2: Ready");

    // 3. Inspect status via task_status
    const statusTool = tools.get("task_status")!;
    const statusRes = await statusTool.execute("call-3", { taskId });
    const statusBody = JSON.parse(statusRes.content[0].text);
    expect(statusBody.ok).toBe(true);
    expect(statusBody.task.status).toBe("done");
    expect(statusBody.task.result.exitCode).toBe(0);
  });

  it("cancels running tasks cleanly via task_cancel", async () => {
    const store = new InMemoryTaskStore();
    const simTime = 2000;

    // Spawner that does not immediately exit
    const asyncSpawner: ProcessSpawner = (_cmd, opts) => {
      opts.onStdoutChunk?.("Running indefinitely...\n");
      return {
        pid: 777,
        kill: (sig) => {
          opts.onExit?.(null, String(sig));
        },
      };
    };

    const plugin = createTaskPlanePlugin({
      reader: store.reader,
      writer: store.writer,
      appender: store.appender,
      outputReader: store.outputReader,
      spawner: asyncSpawner,
      now: () => simTime,
    });

    const { api, tools } = createMockPluginApi();
    plugin.register(api);

    const dispatchTool = tools.get("task_dispatch")!;
    const dispRes = await dispatchTool.execute("c-1", {
      command: "sleep 100",
      owner: "session-main",
    });
    const { taskId } = JSON.parse(dispRes.content[0].text);

    // Cancel the task
    const cancelTool = tools.get("task_cancel")!;
    const cancelRes = await cancelTool.execute("c-2", {
      taskId,
      reason: "User requested abort",
    });

    const cancelBody = JSON.parse(cancelRes.content[0].text);
    expect(cancelBody.ok).toBe(true);
    expect(cancelBody.status).toBe("killed");
    expect(cancelBody.reason).toBe("User requested abort");

    // Check output contains cancellation note
    const outputTool = tools.get("task_output")!;
    const outputRes = await outputTool.execute("c-3", { taskId });
    expect(outputRes.content[0].text).toContain("[TASK_CANCEL] User requested abort");
  });

  it("reconciles restart state upon gateway_start hook", async () => {
    const store = new InMemoryTaskStore();
    // Seed store with one alive task and one dead task
    store.registry = {
      version: 1,
      tasks: {
        "t-alive": {
          id: "t-alive",
          kind: "exec",
          payload: { command: "alive-cmd" },
          owner: "s-1",
          timeoutMs: 600000,
          status: "running",
          output_handle: "/tmp/out-alive.log",
          timestamps: { queuedAt: 1000, startedAt: 1100 },
          pid: 1234,
        },
        "t-dead": {
          id: "t-dead",
          kind: "exec",
          payload: { command: "dead-cmd" },
          owner: "s-2",
          timeoutMs: 600000,
          status: "running",
          output_handle: "/tmp/out-dead.log",
          timestamps: { queuedAt: 1000, startedAt: 1100 },
          pid: 5678,
        },
      },
    };

    // Only PID 1234 is alive
    store.activePids.add(1234);

    const plugin = createTaskPlanePlugin({
      reader: store.reader,
      writer: store.writer,
      appender: store.appender,
      outputReader: store.outputReader,
      pidChecker: store.pidChecker,
      now: () => 3000,
    });

    const { api, hooks, logs } = createMockPluginApi();
    plugin.register(api);

    const startHook = hooks.get("gateway_start")!;
    await startHook({});

    expect(store.registry.tasks["t-alive"].readopted).toBe(true);
    expect(store.registry.tasks["t-alive"].status).toBe("running");

    expect(store.registry.tasks["t-dead"].status).toBe("failed");
    expect(store.registry.tasks["t-dead"].result?.error).toContain("Process 5678 terminated");

    expect(logs.some((l) => l.includes("Restart reconciliation complete"))).toBe(true);
  });

  it("supervisor kills task at timeout cap and appends teach-back with shipped-state", async () => {
    const store = new InMemoryTaskStore();
    let simTime = 1000;

    const fakeShippedState = {
      lastCommitSha: "deadbeefcafe1234",
      lastCommitMessage: "feat: work loop progress before cap",
      lastPushedBranch: "topic/73239-rescue",
      lastPrNumber: 367,
      hasUncommittedChanges: false,
      shippedAt: 600000,
      status: "shipped_clean" as const,
    };

    const asyncSpawner: ProcessSpawner = (_cmd, opts) => {
      return {
        pid: 888,
        kill: (sig) => {
          opts.onExit?.(null, String(sig));
        },
      };
    };

    const plugin = createTaskPlanePlugin({
      reader: store.reader,
      writer: store.writer,
      appender: store.appender,
      outputReader: store.outputReader,
      spawner: asyncSpawner,
      shippedStateReader: () => fakeShippedState,
      now: () => simTime,
    });

    const { api, hooks, tools } = createMockPluginApi();
    plugin.register(api);

    // Boot gateway to start supervisor
    const startHook = hooks.get("gateway_start")!;
    await startHook({});

    // Dispatch a task with 10s timeout
    const dispatchTool = tools.get("task_dispatch")!;
    const res = await dispatchTool.execute("c-1", {
      command: "long-running-work-loop",
      timeoutMs: 10000,
    });
    const { taskId } = JSON.parse(res.content[0].text);

    // Advance time past timeout
    simTime += 15000;

    // Fast-forward interval timer
    await new Promise((r) => setTimeout(r, 1100));

    // Check that task output received enriched post-kill teachback
    const output = store.outputs.get(store.registry.tasks[taskId].output_handle) ?? "";
    expect(output).toContain("[TASK_SUPERVISOR]");
    expect(output).toContain("Killed at 10s lane cap");
    expect(output).toContain("Note: this is a lane timeout, not an LLM provider outage.");
    expect(output).toContain("Observable shipped-state: commit deadbee on branch 'topic/73239-rescue' (PR #367).");
    expect(output).toContain("Work survived by policy — resume checkpoint from this commit.");

    // Clean up
    const stopHook = hooks.get("gateway_stop")!;
    await stopHook({});
  });
});
