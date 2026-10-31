/**
 * Integration tests for the exec_pipeline tool wiring (T-583).
 *
 * @dft
 * - Uses a scripted real Protocol double for the spawner (Axiom 5) — no
 *   vi.fn() patch-overs. The double records commands and stdin inputs and
 *   replays scripted exit codes/outputs.
 * - All persistence and output handles are in-memory doubles.
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
  SpawnOptions,
} from "../src/task-plane-io.js";
import type {
  PluginApi,
  ToolDefinition,
  HookEvent,
  HookContext,
  TaskPlaneRegistry,
} from "../../shared/types.js";
import { createRegistry } from "../src/task-plane-logic.js";

interface ScriptedStep {
  exitCode: number;
  stdout: string;
  stderr?: string;
  error?: string;
}

/** Real in-memory Protocol double: scripted pipeline spawner (Axiom 5). */
class ScriptedPipelineSpawner {
  public calls: Array<{ command: string; input?: string; cwd?: string }> = [];
  private scripts: ScriptedStep[] = [];

  constructor(scripts: ScriptedStep[]) {
    this.scripts = scripts;
  }

  readonly spawner: ProcessSpawner = (command: string, opts: SpawnOptions): SpawnedProcess => {
    const script = this.scripts[this.calls.length] ?? { exitCode: 0, stdout: "" };
    this.calls.push({ command, input: opts.input, cwd: opts.cwd });
    if (script.error) {
      // Defer to next tick so the promise-based wiring settles naturally.
      setTimeout(() => opts.onError?.(new Error(script.error!)), 0);
    } else {
      if (script.stdout && opts.onStdoutChunk) opts.onStdoutChunk(script.stdout);
      if (script.stderr && opts.onStderrChunk) opts.onStderrChunk(script.stderr);
      setTimeout(() => opts.onExit?.(script.exitCode, null), 0);
    }
    return {
      pid: 41000 + this.calls.length,
      kill: (_sig) => {},
    };
  };
}

class InMemoryTaskStore {
  public registry: TaskPlaneRegistry = createRegistry();
  public outputs = new Map<string, string>();

  readonly reader: TaskRegistryReader = () => JSON.parse(JSON.stringify(this.registry));
  readonly writer: TaskRegistryWriter = (data) => {
    this.registry = JSON.parse(JSON.stringify(data));
  };
  readonly appender: OutputAppender = (handle, chunk) => {
    this.outputs.set(handle, (this.outputs.get(handle) ?? "") + chunk);
  };
  readonly outputReader: OutputReader = (handle) => this.outputs.get(handle) ?? "";
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
    on: (name, handler) => { hooks.set(name, handler); },
    registerHook: () => {},
    registerTool: (tool) => { tools.set(tool.name, tool); },
  };
  return { api, tools, hooks, logs };
}

function setup(scripts: ScriptedStep[], simTime = 1000) {
  const store = new InMemoryTaskStore();
  const fake = new ScriptedPipelineSpawner(scripts);
  const plugin = createTaskPlanePlugin({
    reader: store.reader,
    writer: store.writer,
    appender: store.appender,
    outputReader: store.outputReader,
    spawner: fake.spawner,
    now: () => simTime,
  });
  const { api, tools } = createMockPluginApi();
  plugin.register(api);
  const tool = tools.get("exec_pipeline");
  if (!tool) throw new Error("exec_pipeline tool not registered");
  return { store, fake, tool };
}

describe("exec_pipeline tool (T-583)", () => {
  it("is registered alongside the four existing task tools", () => {
    const { tool } = setup([]);
    expect(tool).toBeDefined();
  });

  it("rejects invalid specs with a precise error and spawns nothing", async () => {
    const { fake, tool } = setup([]);
    const res = await tool.execute("c-1", { steps: [{ command: "" }] });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("step 0 requires a non-empty 'command' string");
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a missing steps array", async () => {
    const { fake, tool } = setup([]);
    const res = await tool.execute("c-1", {});
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("non-empty 'steps' array");
    expect(fake.calls).toHaveLength(0);
  });

  it("runs sequential steps in order, defaulting conditions to always", async () => {
    const { fake, tool } = setup([
      { exitCode: 0, stdout: "step-one\n" },
      { exitCode: 0, stdout: "step-two\n" },
    ]);
    const res = await tool.execute("c-1", {
      steps: [{ command: "echo one" }, { command: "echo two" }],
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(fake.calls.map((c) => c.command)).toEqual(["echo one", "echo two"]);
    expect(body.report.executedCount).toBe(2);
    expect(body.report.skippedCount).toBe(0);
    expect(body.steps[0].stdoutTail).toContain("step-one");
    expect(body.steps[1].stdoutTail).toContain("step-two");
  });

  it("skips on_success steps after a failure and runs on_failure recovery steps", async () => {
    const { fake, tool } = setup([
      { exitCode: 0, stdout: "ok\n" },
      { exitCode: 4, stdout: "", stderr: "boom\n" },
      { exitCode: 0, stdout: "recovered\n" },
      { exitCode: 0, stdout: "after-recovery\n" },
    ]);
    const res = await tool.execute("c-1", {
      steps: [
        { command: "step-a" },
        { command: "step-b-fails" },
        { command: "step-c-on-success", condition: "on_success" },
        { command: "step-d-on-failure", condition: "on_failure" },
        { command: "step-e-on-success", condition: "on_success" },
      ],
      stopOnFailure: false,
    });
    const body = JSON.parse(res.content[0].text);
    // Executed: a, b(fails), d(on_failure recovery), e(on_success — d recovered).
    // Skipped: c (previous step b failed).
    expect(fake.calls.map((c) => c.command)).toEqual([
      "step-a",
      "step-b-fails",
      "step-d-on-failure",
      "step-e-on-success",
    ]);
    expect(body.ok).toBe(false);
    expect(body.report.failedStepIndex).toBe(1);
    expect(body.steps[2].skipped).toBe(true);
    expect(body.steps[2].skipReason).toContain("on_success");
    expect(body.steps[3].executed).toBe(true);
    expect(body.steps[4].executed).toBe(true);
  });

  it("stopOnFailure (default) aborts remaining steps after a failure", async () => {
    const { fake, tool } = setup([
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "never\n" },
    ]);
    const res = await tool.execute("c-1", {
      steps: [{ command: "fails" }, { command: "never-runs", condition: "on_failure" }],
    });
    const body = JSON.parse(res.content[0].text);
    expect(fake.calls.map((c) => c.command)).toEqual(["fails"]);
    expect(body.report.skippedCount).toBe(1);
    expect(body.ok).toBe(false);
  });

  it("piped mode feeds each step's stdout into the next step's stdin", async () => {
    const { fake, tool } = setup([
      { exitCode: 0, stdout: "hello world\n" },
      { exitCode: 0, stdout: "HELLO WORLD\n" },
      { exitCode: 0, stdout: "done\n" },
    ]);
    const res = await tool.execute("c-1", {
      steps: [{ command: "echo hello world" }, { command: "tr a-z A-Z" }, { command: "cat" }],
      mode: "piped",
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(fake.calls[0].input).toBeUndefined();
    expect(fake.calls[1].input).toBe("hello world\n");
    expect(fake.calls[2].input).toBe("HELLO WORLD\n");
  });

  it("records the run as a TaskPlane task (done on success)", async () => {
    const { store, tool } = setup([{ exitCode: 0, stdout: "fine\n" }]);
    const res = await tool.execute("c-1", { steps: [{ command: "ok-step" }] });
    const body = JSON.parse(res.content[0].text);
    const task = store.registry.tasks[body.taskId];
    expect(task).toBeDefined();
    expect(task.status).toBe("done");
    expect(task.result?.exitCode).toBe(0);
    const handleOutput = store.outputs.get(task.output_handle) ?? "";
    expect(handleOutput).toContain("fine");
    expect(handleOutput).toContain("exec_pipeline: 1 step(s)");
  });

  it("records the run as a failed task with a failure reason", async () => {
    const { store, tool } = setup([
      { exitCode: 2, stdout: "" },
    ]);
    const res = await tool.execute("c-1", { steps: [{ command: "broken-step" }] });
    const body = JSON.parse(res.content[0].text);
    const task = store.registry.tasks[body.taskId];
    expect(task.status).toBe("failed");
    expect(task.result?.exitCode).toBe(2);
    expect(task.result?.error).toContain("step 0");
  });

  it("passes cwd through to the spawner for every step", async () => {
    const { fake, tool } = setup([{ exitCode: 0, stdout: "" }]);
    await tool.execute("c-1", {
      steps: [{ command: "pwd" }],
      cwd: "/tmp/pipeline-cwd",
    });
    expect(fake.calls[0].cwd).toBe("/tmp/pipeline-cwd");
  });
});
