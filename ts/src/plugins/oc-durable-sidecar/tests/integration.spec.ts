/**
 * Integration spec — wiring through an in-memory Protocol double (DFT Axiom 5).
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildSpawnRequest,
  interpretTransportFailure,
} from "../src/durable-sidecar-logic.js";
import { makeHttpFetchJson } from "../src/durable-sidecar-io.js";
import type { PluginApi, ToolDefinition } from "../../shared/types.js";

class FakePluginApiClient {
  public tools = new Map<string, ToolDefinition>();
  public hooks = new Map<string, (event: unknown) => unknown>();

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  on(hook: string, handler: (event: unknown) => unknown): void {
    this.hooks.set(hook, handler);
  }
}

class FakeSidecarClient {
  public calls: Array<{ url: string; init?: RequestInit }> = [];
  public shouldAbort = false;
  public mockResponses = new Map<string, { status: number; body: Record<string, unknown> }>();

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = String(url);
    this.calls.push({ url: urlStr, init });

    if (this.shouldAbort) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("This operation was aborted"));
        });
      });
    }

    for (const [pattern, resp] of this.mockResponses.entries()) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), { status: resp.status });
      }
    }

    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
}

describe("http fetch wrapper", () => {
  it("posts JSON bodies and parses JSON responses", async () => {
    const client = new FakeSidecarClient();
    client.mockResponses.set("/spawn", {
      status: 200,
      body: { task_id: "t-9" },
    });
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => client.fetch(url, init));

    const fetchJson = makeHttpFetchJson("http://127.0.0.1:18950");
    const res = await fetchJson(buildSpawnRequest("agent_step", { a: 1 }, "default"), 5_000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ task_id: "t-9" });
    expect(client.calls[0].url).toBe("http://127.0.0.1:18950/spawn");
    expect(JSON.parse(String(client.calls[0].init?.body))).toEqual({
      task_name: "agent_step", params: { a: 1 }, queue: "default",
    });
  });

  it("aborts on timeout; transport failure classifies as sidecar-down", async () => {
    const client = new FakeSidecarClient();
    client.shouldAbort = true;
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => client.fetch(url, init));

    const fetchJson = makeHttpFetchJson("http://127.0.0.1:18950");
    await expect(
      fetchJson({ method: "GET", path: "/status" }, 50),
    ).rejects.toThrow(/aborted/);

    // callers catch the transport failure and classify it (pure seam)
    let verdict: string;
    try {
      await fetchJson({ method: "GET", path: "/status" }, 50);
      verdict = "no-timeout";
    } catch (err) {
      verdict = interpretTransportFailure(err).verdict;
    }
    expect(verdict).toBe("sidecar-down");
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("plugin registers tools and properly classifies outcomes", async () => {
    const api = new FakePluginApiClient();
    const plugin = (await import("../src/index.js")).default;
    plugin.register(api as unknown as PluginApi);

    expect(api.tools.has("durable_spawn")).toBe(true);
    expect(api.tools.has("durable_status")).toBe(true);
    expect(api.tools.has("durable_result")).toBe(true);
    expect(api.tools.has("durable_wait")).toBe(true);
    expect(api.tools.has("durable_retry")).toBe(true);
    expect(api.tools.has("durable_tasks")).toBe(true);
    expect(api.tools.has("durable_list")).toBe(true);

    const client = new FakeSidecarClient();
    client.mockResponses.set("/task/fail-task", {
      status: 200,
      body: { task_id: "fail-task", state: "failed", result: { error: "fatal" } },
    });
    client.mockResponses.set("/task/wait-task", {
      status: 200,
      body: { task_id: "wait-task", state: "completed", result: { ok: true } },
    });
    client.mockResponses.set("/tasks/runs", {
      status: 200,
      body: {
        runs: [
          { task_id: "run-101", task_name: "agent_step", state: "completed", summary: "rebuild done" },
        ],
      },
    });
    client.mockResponses.set("/tasks", {
      status: 200,
      body: {
        tasks: [
          { name: "agent_step", description: "step description", queue: "default" },
        ],
      },
    });
    client.mockResponses.set("/task/retry-1/retry", {
      status: 200,
      body: { task_id: "retry-1", state: "pending" },
    });
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => client.fetch(url, init));

    const resultExec = api.tools.get("durable_result")!.execute;
    const failedOutcome = await resultExec("call-1", { task_id: "fail-task" });
    expect(failedOutcome.content[0].text).toMatch(/^failed: state=failed/);

    const waitExec = api.tools.get("durable_wait")!.execute;
    const waitOutcome = await waitExec("call-2", { task_id: "wait-task", timeout_seconds: 300 });
    expect(waitOutcome.content[0].text).toMatch(/^ok: state=completed/);

    // Test durable_tasks
    const tasksExec = api.tools.get("durable_tasks")!.execute;
    const tasksOutcome = await tasksExec("call-3", {});
    expect(tasksOutcome.content[0].text).toContain("tasks registered (1):");
    expect(tasksOutcome.content[0].text).toContain("agent_step [queue: default]");

    // Test durable_list
    const listExec = api.tools.get("durable_list")!.execute;
    const listOutcome = await listExec("call-4", { task_name: "agent_step" });
    expect(listOutcome.content[0].text).toContain("recent runs (1):");
    expect(listOutcome.content[0].text).toContain("run-101 (agent_step) [completed]: rebuild done");

    // Test durable_retry with resume: false
    const retryExec = api.tools.get("durable_retry")!.execute;
    const retryOutcome = await retryExec("call-5", { task_id: "retry-1", resume: false });
    expect(retryOutcome.content[0].text).toMatch(/^pending: state=pending/);
    const retryCall = client.calls.find((c) => c.url.includes("/retry-1/retry"));
    expect(retryCall).toBeDefined();
    expect(JSON.parse(String(retryCall?.init?.body))).toEqual({ resume: false });
  });
});
