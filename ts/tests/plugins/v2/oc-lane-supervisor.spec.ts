import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/v2/oc-lane-supervisor/src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

interface CapturedHook {
  event: string;
  handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;
}

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: CapturedTool[] = [];
  const logs: string[] = [];
  const warns: string[] = [];

  const api = {
    on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => warns.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
  return { api, hooks, tools, logs, warns };
}

function getHook(hooks: CapturedHook[], event: string): CapturedHook {
  const h = hooks.find((h) => h.event === event);
  if (!h) throw new Error(`Hook ${event} not registered`);
  return h;
}

describe("Plugins v2: oc-lane-supervisor Consolidated Engine Integration", () => {
  it("conforms bidirectionally with openclaw.plugin.json manifest contracts", () => {
    const manifestPath = resolve(
      __dirname,
      "../../../src/plugins/v2/oc-lane-supervisor/openclaw.plugin.json"
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});

    const registeredHooks = hooks.map((h) => h.event);
    const registeredTools = tools.map((t) => t.name);

    expect(manifest.contracts.hooks.sort()).toEqual(registeredHooks.sort());
    expect(manifest.contracts.tools.sort()).toEqual(registeredTools.sort());
  });

  it("exports all 5 consolidated tools: session_health, session_cleanup, lane_forecast, topic_audit, topic_recover", () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});

    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "lane_forecast",
      "session_cleanup",
      "session_health",
      "topic_audit",
      "topic_recover",
    ]);
  });

  it("executes turn energy budgeting, circuit breakers, and soft landing in consolidated engine", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, { initialSessionTier: "constrained" });

    const beforeRun = getHook(hooks, "before_agent_run");
    const beforeTool = getHook(hooks, "before_tool_call");
    const persistTool = getHook(hooks, "tool_result_persist");

    const ctx = { sessionId: "v2-session-1" };

    await beforeRun.handler({ prompt: "Perform deep diagnostics" }, ctx);

    // Initial tool call allowed
    const allowRes = (await beforeTool.handler(
      { toolName: "read", params: { path: "spec.md" } },
      ctx
    )) as { block?: boolean };
    expect(allowRes?.block).toBeUndefined();

    // Zero-delta poll drain loop
    for (let i = 0; i < 6; i++) {
      await persistTool.handler(
        {
          toolName: "process",
          message: {
            role: "toolResult",
            toolName: "process",
            content: [{ type: "text", text: "(no new output)" }],
          },
        },
        ctx
      );
    }

    // Must be cleanly gated by turn energy exhaustion
    const gatedRes = (await beforeTool.handler(
      { toolName: "exec", params: { command: "curl" } },
      ctx
    )) as { block: boolean; blockReason: string };

    expect(gatedRes.block).toBe(true);
    expect(gatedRes.blockReason).toContain("Turn energy budget exhausted");
  });

  it("executes lane_forecast tool with duration prediction and advice", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});

    const forecastTool = tools.find((t) => t.name === "lane_forecast");
    expect(forecastTool).toBeDefined();

    const res = (await forecastTool!.execute("id-1", {
      prompt: "Run full integration suite and build all docker containers",
      command: "docker build -t test .",
    })) as { content: Array<{ type: string; text: string }> };

    expect(res.content[0].text).toContain("prediction");
    expect(res.content[0].text).toContain("predictedDurationMs");
  });

  it("executes topic_audit and topic_recover tools cleanly", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});

    const auditTool = tools.find((t) => t.name === "topic_audit");
    const recoverTool = tools.find((t) => t.name === "topic_recover");
    expect(auditTool).toBeDefined();
    expect(recoverTool).toBeDefined();

    const auditRes = (await auditTool!.execute("id-2", {
      topics: [{ message_thread_id: 83272, title: "Plugins Team" }],
      registrations: [{ topicId: 83272, sessionKey: "agent:main:topic:83272" }],
      health: false,
    })) as { content: Array<{ type: string; text: string }> };

    const parsedAudit = JSON.parse(auditRes.content[0].text);
    expect(parsedAudit.orphaned).toBeDefined();
    expect(parsedAudit.orphaned.length).toBe(0);
    expect(parsedAudit.unregistered.length).toBe(0);

    const recoverRes = (await recoverTool!.execute("id-3", {
      topicId: 99999,
      chatId: "-100123",
      agentId: "main",
      apply: false,
    })) as { content: Array<{ type: string; text: string }> };

    const parsedRecover = JSON.parse(recoverRes.content[0].text);
    expect(parsedRecover.sessionKey).toContain("topic:99999");
  });
});
