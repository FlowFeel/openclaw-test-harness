import { describe, it, expect, vi } from "vitest";
import { createTaskPlanePlugin } from "../src/index.js";
import {
  formatTaskWakeMessage,
  type GatewayWakeParams,
} from "../src/task-plane-wake.js";
import type { TaskPlaneRegistry, PluginApi } from "../../shared/types.js";
import type { ProcessSpawner, SpawnedProcess } from "../src/task-plane-io.js";

describe("T-574: TaskPlane real wake RPC wiring (handleWake)", () => {
  it("formats task wake message cleanly with task ID and status", () => {
    const text = formatTaskWakeMessage({
      targetSessionKey: "agent:main:telegram:group:123:topic:456",
      taskId: "task-001",
      status: "succeeded",
      output_handle: "/path/to/task-001.log",
    });
    expect(text).toBe(
      "[Task Complete] Task task-001 finished with status: succeeded. Output: /path/to/task-001.log"
    );
  });

  it("dispatches wake(mode='now') with targetSessionKey on task completion", async () => {
    const registry: TaskPlaneRegistry = { tasks: {}, version: 1 };
    const sentWakes: GatewayWakeParams[] = [];

    const mockWakeSender = vi.fn(async (params: GatewayWakeParams) => {
      sentWakes.push(params);
      return { ok: true };
    });

    let exitCallback: ((code: number | null, signal: string | null) => void) | undefined;
    const mockSpawner: ProcessSpawner = (_cmd, opts) => {
      exitCallback = opts.onExit;
      const proc: SpawnedProcess = {
        pid: 9999,
        kill: vi.fn(),
      };
      return proc;
    };

    const plugin = createTaskPlanePlugin({
      reader: () => registry,
      writer: vi.fn(),
      appender: vi.fn(),
      outputReader: () => "Sample output tail line 1\nLine 2",
      spawner: mockSpawner,
      wakeSender: mockWakeSender,
      now: () => 1700000000000,
    });

    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const mockApi: Partial<PluginApi> = {
      registerTool: (tool) => {
        tools.push(tool as never);
      },
      on: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    plugin.register(mockApi as PluginApi, {});

    const dispatchTool = tools.find((t) => t.name === "task_dispatch");
    expect(dispatchTool).toBeDefined();

    // Dispatch background exec task with owner session key
    const targetSession = "agent:main:telegram:group:-1003842172831:topic:73239";
    await dispatchTool!.execute("call-1", {
      kind: "exec",
      command: "sleep 2 && echo done",
      owner: targetSession,
      timeoutMs: 10000,
    });

    // Simulate process completion
    expect(exitCallback).toBeDefined();
    exitCallback!(0, null);

    // Assert wake RPC was called
    expect(mockWakeSender).toHaveBeenCalledTimes(1);
    expect(sentWakes.length).toBe(1);
    expect(sentWakes[0].mode).toBe("now");
    expect(sentWakes[0].sessionKey).toBe(targetSession);
    expect(sentWakes[0].text).toContain("finished with status: done");
  });

  it("dispatches wake(mode='now') with failure status on task error", async () => {
    const registry: TaskPlaneRegistry = { tasks: {}, version: 1 };
    const sentWakes: GatewayWakeParams[] = [];

    const mockWakeSender = vi.fn(async (params: GatewayWakeParams) => {
      sentWakes.push(params);
      return { ok: true };
    });

    let exitCallback: ((code: number | null, signal: string | null) => void) | undefined;
    const mockSpawner: ProcessSpawner = (_cmd, opts) => {
      exitCallback = opts.onExit;
      const proc: SpawnedProcess = {
        pid: 9998,
        kill: vi.fn(),
      };
      return proc;
    };

    const plugin = createTaskPlanePlugin({
      reader: () => registry,
      writer: vi.fn(),
      appender: vi.fn(),
      outputReader: () => "Fatal error occurred",
      spawner: mockSpawner,
      wakeSender: mockWakeSender,
      now: () => 1700000000000,
    });

    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    const mockApi: Partial<PluginApi> = {
      registerTool: (tool) => {
        tools.push(tool as never);
      },
      on: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    plugin.register(mockApi as PluginApi, {});

    const dispatchTool = tools.find((t) => t.name === "task_dispatch");
    const targetSession = "agent:main:telegram:group:-1003842172831:topic:93299";
    await dispatchTool!.execute("call-2", {
      kind: "exec",
      command: "exit 1",
      owner: targetSession,
    });

    // Simulate process error exit
    exitCallback!(1, null);

    expect(mockWakeSender).toHaveBeenCalledTimes(1);
    expect(sentWakes[0].mode).toBe("now");
    expect(sentWakes[0].sessionKey).toBe(targetSession);
    expect(sentWakes[0].text).toContain("finished with status: failed");
  });
});
