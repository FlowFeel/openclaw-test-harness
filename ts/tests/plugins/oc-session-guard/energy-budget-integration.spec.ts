import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-session-guard/src/index.js";

interface CapturedHook {
  event: string;
  handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;
}

interface CapturedTool {
  name: string;
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

describe("Phase 2: oc-session-guard Energy Budget & Soft Landing Integration", () => {
  it("initializes turn energy on before_agent_run and deducts energy on tool_result_persist", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, { initialSessionTier: "standard" });

    const beforeRun = getHook(hooks, "before_agent_run");
    const beforeTool = getHook(hooks, "before_tool_call");
    const persistTool = getHook(hooks, "tool_result_persist");

    const ctx = { sessionId: "session-1" };

    // 1. Turn starts
    await beforeRun.handler({ prompt: "Do research" }, ctx);

    // 2. Tool call allowed
    const allowVerdict = (await beforeTool.handler({ toolName: "read", params: { path: "foo.txt" } }, ctx)) as {
      block?: boolean;
    };
    expect(allowVerdict?.block).toBeUndefined();

    // 3. Tool result persists -> deducts energy
    const persistRes = (await persistTool.handler(
      {
        toolName: "read",
        message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file content" }] },
      },
      ctx,
    )) as { message: { content: Array<{ type: string; text: string }> } };

    expect(persistRes.message).toBeDefined();
    // Default 1000E has not crossed advisory threshold yet, so content is normal
    expect(persistRes.message.content.some((c) => c.text.includes("Energy advisory"))).toBe(false);
  });

  it("injects energy advisory into tool result and gates tool execution when energy is exhausted", async () => {
    const { api, hooks, warns } = createMockApi();
    // Start with constrained tier (600E) to easily exhaust
    plugin.register(api as never, { initialSessionTier: "constrained" });

    const beforeRun = getHook(hooks, "before_agent_run");
    const beforeTool = getHook(hooks, "before_tool_call");
    const persistTool = getHook(hooks, "tool_result_persist");

    const ctx = { sessionId: "session-exhaust" };

    await beforeRun.handler({ prompt: "Investigate" }, ctx);

    // Run a heavy tool call or simulated multiple calls that exhaust the 600E pool
    // e.g. 5 consecutive zero-delta polls (each zero-delta poll is -100E + poll drain)
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
        ctx,
      );
    }

    // Now energy should be exhausted. Next before_tool_call must be blocked with soft-landing message
    const gateVerdict = (await beforeTool.handler(
      { toolName: "exec", params: { command: "ls" } },
      ctx,
    )) as { block: boolean; blockReason: string };

    expect(gateVerdict.block).toBe(true);
    expect(gateVerdict.blockReason).toContain("Turn energy budget exhausted");
    expect(warns.some((w) => w.includes("energy budget exhausted"))).toBe(true);
  });

  it("updates rolling TES and session tier at agent_end", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { initialSessionTier: "standard" });

    const beforeRun = getHook(hooks, "before_agent_run");
    const persistTool = getHook(hooks, "tool_result_persist");
    const agentEnd = getHook(hooks, "agent_end");

    const ctx = { sessionId: "session-rep" };

    await beforeRun.handler({ prompt: "Perform task" }, ctx);

    // Offload task via task_dispatch -> earns delegation rebate and habit points (+150P)
    await persistTool.handler(
      {
        toolName: "task_dispatch",
        message: { role: "toolResult", toolName: "task_dispatch", content: [{ type: "text", text: "task-123" }] },
      },
      ctx,
    );

    // Conclude turn
    await agentEnd.handler({}, ctx);

    expect(logs.some((l) => l.includes("turn efficiency: TES="))).toBe(true);
  });

  it("Phase 3: injects cognitive envelope header when enableEnergyEnvelopeHeaders is true", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, {
      initialSessionTier: "sovereign",
      enableEnergyEnvelopeHeaders: true,
    });

    const beforeRun = getHook(hooks, "before_agent_run");
    const persistTool = getHook(hooks, "tool_result_persist");
    const ctx = { sessionId: "session-headers" };

    await beforeRun.handler({ prompt: "Investigate" }, ctx);

    const persistRes = (await persistTool.handler(
      {
        toolName: "read",
        message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "data" }] },
      },
      ctx,
    )) as { message: { content: Array<{ type: string; text: string }> } };

    expect(
      persistRes.message.content.some((c) =>
        c.text.includes("[⚡ Energy: ") && c.text.includes("Tier: SOVEREIGN") && c.text.includes("Habits: +50P"),
      ),
    ).toBe(true);
  });

  it("Phase 3: session_health includes habit telemetry card and reputation", async () => {
    const { api, tools } = createMockApi();
    const sessionsPath = "/tmp/mock-sessions-health.json";
    const fs = await import("node:fs");
    fs.writeFileSync(sessionsPath, JSON.stringify({ "session-1": { model: "test" } }));

    plugin.register(api as never, {
      sessionsPath,
      initialSessionTier: "sovereign",
    });

    const healthTool = tools.find((t) => t.name === "session_health");
    expect(healthTool).toBeDefined();

    const result = (await healthTool!.execute("id-1", {})) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0].text).toContain("efficiencyCard");
    expect(result.content[0].text).toContain("SOVEREIGN");
    expect(result.content[0].text).toContain("Session Efficiency: Tier 3");

    fs.rmSync(sessionsPath, { force: true });
  });
});
