import { describe, it, expect, vi } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-task-plane/src/index.js";
import type { PluginApi, ToolDefinition } from "../../../src/plugins/shared/types.js";
import type { SidecarResponse } from "../../../src/plugins/v2/oc-task-plane/src/durable-sidecar-logic.js";
import type { FetchRevisionResult } from "../../../src/plugins/v2/oc-task-plane/src/staging-verify-io.js";

describe("Unified Engine: oc-task-plane (Plugins v2)", () => {
  function createTestApi() {
    const tools = new Map<string, ToolDefinition>();
    const hooks = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();

    const api: PluginApi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      on(hookName: string, handler: (event: any, ctx?: any) => unknown) {
        if (!hooks.has(hookName)) hooks.set(hookName, []);
        hooks.get(hookName)!.push(handler as any);
      },
      registerHook: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    return { api, tools, hooks };
  }

  it("registers all 11 consolidated tools and lifecycle hooks", () => {
    const { api, tools, hooks } = createTestApi();
    pluginDef.register(api, {
      registryPath: "/tmp/mock-tasks.json",
      outputDir: "/tmp/mock-output",
    });

    const expectedTools = [
      "task_dispatch",
      "task_status",
      "task_output",
      "task_cancel",
      "exec_pipeline",
      "staging_verify",
      "subagent_health",
      "queue_work",
      "queue_status",
      "queue_results",
      "merge_results",
      "durable_spawn",
      "durable_status",
      "durable_result",
      "durable_wait",
      "durable_retry",
      "durable_tasks",
      "durable_list",
    ];

    for (const tool of expectedTools) {
      expect(tools.has(tool), `Tool ${tool} must be registered`).toBe(true);
    }

    expect(hooks.has("gateway_start")).toBe(true);
    expect(hooks.has("gateway_stop")).toBe(true);
  });

  it("executes task_dispatch, task_status, and task_cancel in-memory", async () => {
    const { api, tools } = createTestApi();
    pluginDef.register(api, {
      registryPath: "/tmp/test-tasks.json",
      outputDir: "/tmp/test-output",
    });

    const dispatchTool = tools.get("task_dispatch")!;
    const statusTool = tools.get("task_status")!;
    const cancelTool = tools.get("task_cancel")!;

    // 1. Dispatch
    const dispatchRes = await dispatchTool.execute("call-1", {
      kind: "exec",
      command: "echo 'hello'",
      owner: "session-test",
    });
    const parsedDispatch = JSON.parse(dispatchRes.content[0].text);
    expect(parsedDispatch.ok).toBe(true);
    expect(parsedDispatch.taskId).toBeDefined();
    expect(parsedDispatch.status).toBe("running");

    // 2. Status
    const statusRes = await statusTool.execute("call-2", { taskId: parsedDispatch.taskId });
    const parsedStatus = JSON.parse(statusRes.content[0].text);
    expect(parsedStatus.ok).toBe(true);
    expect(parsedStatus.task.id).toBe(parsedDispatch.taskId);

    // 3. Cancel
    const cancelRes = await cancelTool.execute("call-3", {
      taskId: parsedDispatch.taskId,
      reason: "Unit test termination",
    });
    const parsedCancel = JSON.parse(cancelRes.content[0].text);
    expect(parsedCancel.ok).toBe(true);
    expect(parsedCancel.status).toBe("killed");
  });

  it("handles staging_verify with mock revision fetcher", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      payload: { sha: "a1b2c3d4e5f6789012345678901234567890abcd" },
    } as FetchRevisionResult);

    const { api, tools } = createTestApi();
    pluginDef.register(api, {
      fetchStagingRevision: mockFetcher,
    });

    const verifyTool = tools.get("staging_verify")!;
    const res = await verifyTool.execute("call-verify", {
      url: "https://staging.test/version.json",
      expectedSha: "a1b2c3d4e5f6789012345678901234567890abcd",
    });

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.status).toBe("live");
  });

  it("proxies durable sidecar operations via injected fetchJson", async () => {
    const mockFetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: { task_id: "absurd-42", state: "running" },
    } as SidecarResponse);

    const { api, tools } = createTestApi();
    pluginDef.register(api, {
      fetchJson: mockFetchJson,
    });

    const spawnTool = tools.get("durable_spawn")!;
    const res = await spawnTool.execute("call-durable", {
      task_name: "test_job",
      params: { foo: "bar" },
    });

    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/spawn",
        body: expect.objectContaining({ task_name: "test_job" }),
      }),
      180000
    );
    expect(res.content[0].text).toContain("pending: state=running");
  });

  it("runs subagent work queue scheduler tools", async () => {
    const { api, tools } = createTestApi();
    pluginDef.register(api, { maxConcurrentSubagents: 4 });

    const queueWork = tools.get("queue_work")!;
    const queueStatus = tools.get("queue_status")!;

    const workRes = await queueWork.execute("call-qw", {
      tasks: [
        { id: "task-1", prompt: "first search" },
        { id: "task-2", prompt: "second search" },
      ],
    });

    const parsedWork = JSON.parse(workRes.content[0].text);
    expect(parsedWork.queued).toBe(2);
    expect(parsedWork.dispatched).toBe(2);

    const statusRes = await queueStatus.execute("call-qs", {});
    const parsedStatus = JSON.parse(statusRes.content[0].text);
    expect(parsedStatus.ok).toBe(true);
    expect(parsedStatus.total).toBe(2);
  });
});
