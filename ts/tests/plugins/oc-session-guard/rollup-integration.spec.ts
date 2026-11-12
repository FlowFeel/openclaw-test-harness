/**
 * Integration tests for the oc-session-guard turn-finalization rollup (T-583).
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools (same pattern as
 *   integration.spec.ts).
 * - Verifies agent_end is registered, transcript slices get squashed, the
 *   per-turn tracker logs qualifying bursts, and mid-turn tool results are
 *   never modified.
 */

import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-session-guard/src/index.js";

interface CapturedHook {
  event: string;
  handler: (event: unknown, ctx?: unknown) => Promise<unknown>;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: { name: string }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const api = {
    on: (event: string, handler: CapturedHook["handler"]) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: { name: string }) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      warn: () => {},
      debug: () => {},
    },
  };
  return { api, hooks, tools, logs, errors };
}

function getHook(hooks: CapturedHook[], event: string): CapturedHook {
  const h = hooks.find((h) => h.event === event);
  if (!h) throw new Error(`Hook ${event} not registered`);
  return h;
}

function tr(toolName: string, text: string) {
  return { role: "toolResult", toolName, content: [{ type: "text", text }] };
}

function burst(toolName: string, n: number) {
  return Array.from({ length: n }, (_, i) => tr(toolName, `result ${i + 1}`));
}

describe("oc-session-guard turn-finalization rollup (T-583)", () => {
  it("registers the agent_end hook alongside the existing hooks", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual([
      "before_tool_call",
      "tool_result_persist",
      "before_message_write",
      "before_agent_run",
      "after_compaction",
      "session_end",
      "agent_end",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["session_health", "session_cleanup"]);
  });

  it("squashes a qualifying burst in an agent_end transcript slice and returns a report", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const messages = [
      { role: "user", content: "explore" },
      ...burst("exec", 6),
      { role: "assistant", content: "answer" },
    ];
    const result = (await getHook(hooks, "agent_end").handler({ messages })) as {
      messages: unknown[];
      report: { changed: boolean; burstsRolled: number; entriesRemoved: number };
    };

    expect(result.messages).toHaveLength(3);
    const summary = result.messages[1] as { toolName: string; content: Array<{ text: string }> };
    expect(summary.toolName).toBe("session_guard_rollup");
    expect(summary.content[0].text).toContain("[oc-session-guard rollup]");
    expect(result.report.burstsRolled).toBe(1);
    expect(result.report.entriesRemoved).toBe(5);
    expect(logs.some((l) => l.includes("agent_end rollup: 1 burst(s) squashed"))).toBe(true);
  });

  it("returns the transcript untouched when no burst qualifies", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const messages = [{ role: "user", content: "hi" }, ...burst("exec", 2)];
    const result = (await getHook(hooks, "agent_end").handler({ messages })) as {
      messages: unknown[];
      report: { changed: boolean };
    };
    expect(result.messages).toEqual(messages);
    expect(result.report.changed).toBe(false);
  });

  it("rolls only qualifying bursts inside a mixed transcript slice", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const messages = [
      ...burst("exec", 3),
      { role: "assistant", content: "phase 2" },
      ...burst("read", 6),
    ];
    const result = (await getHook(hooks, "agent_end").handler({ messages })) as {
      messages: unknown[];
      report: { burstsRolled: number };
    };
    // 3 non-qualifying exec results stay, assistant stays, 6 read results → 1 summary.
    expect(result.messages).toHaveLength(5);
    expect(result.report.burstsRolled).toBe(1);
  });

  it("does not modify the persisted message in tool_result_persist (no mid-turn interruption)", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, {});

    const message = tr("exec", "some discovery output");
    const returned = (await getHook(hooks, "tool_result_persist").handler(
      { message, toolName: "exec" },
      { sessionId: "sess-1" },
    )) as { message: unknown };
    expect(returned.message).toEqual(message);
  });

  it("finalizes the per-session turn tracker at agent_end and logs qualifying bursts", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const persist = getHook(hooks, "tool_result_persist");
    for (let i = 0; i < 6; i++) {
      await persist.handler({ message: tr("exec", `r${i}`), toolName: "exec" }, { sessionId: "sess-9" });
    }
    await persist.handler(
      { message: tr("task_dispatch", "dispatched"), toolName: "task_dispatch" },
      { sessionId: "sess-9" },
    );

    const result = await getHook(hooks, "agent_end").handler({}, { sessionId: "sess-9" });
    expect(result).toEqual({}); // no messages in event → event passed through
    const log = logs.find((l) => l.includes("agent_end rollup:"));
    expect(log).toBeDefined();
    expect(log).toContain("1 qualifying burst(s)");
    expect(log).toContain("sizes: 6");
  });

  it("does not log a rollup when the turn had no qualifying bursts", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const persist = getHook(hooks, "tool_result_persist");
    for (let i = 0; i < 2; i++) {
      await persist.handler({ message: tr("exec", `r${i}`), toolName: "exec" }, { sessionId: "sess-A" });
    }
    await getHook(hooks, "agent_end").handler({}, { sessionId: "sess-A" });
    expect(logs.some((l) => l.includes("agent_end rollup:"))).toBe(false);
  });

  it("tracks sessions independently", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { rollupMinBurstSize: 6 });

    const persist = getHook(hooks, "tool_result_persist");
    for (let i = 0; i < 6; i++) {
      await persist.handler({ message: tr("exec", `r${i}`), toolName: "exec" }, { sessionId: "sess-B" });
    }
    await persist.handler({ message: tr("exec", "single"), toolName: "exec" }, { sessionId: "sess-C" });

    await getHook(hooks, "agent_end").handler({}, { sessionId: "sess-C" });
    expect(logs.some((l) => l.includes("agent_end rollup:"))).toBe(false); // sess-C had 1 transient step

    await getHook(hooks, "agent_end").handler({}, { sessionId: "sess-B" });
    expect(logs.some((l) => l.includes("1 qualifying burst(s)"))).toBe(true); // sess-B had 6
  });

  it("respects rollupTransientSteps: false — no tracking, no rollup", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { rollupTransientSteps: false, rollupMinBurstSize: 1 });

    const persist = getHook(hooks, "tool_result_persist");
    await persist.handler({ message: tr("exec", "r"), toolName: "exec" }, { sessionId: "sess-D" });

    const messages = [...burst("exec", 3)];
    const result = (await getHook(hooks, "agent_end").handler({ messages })) as {
      messages: unknown[];
    };
    expect(result.messages).toEqual(messages);
    expect(logs.some((l) => l.includes("agent_end rollup:"))).toBe(false);
  });

  it("agent_end errors are caught and logged (never throw)", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    // Malformed event must not throw
    const result = await getHook(hooks, "agent_end").handler({ messages: "not-an-array" });
    expect(result).toEqual({ messages: "not-an-array" });
    expect(errors).toHaveLength(0);
  });
});
