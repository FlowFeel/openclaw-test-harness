/**
 * oc-topic-manager integration specs — fires tools through a mock PluginApi.
 *
 * @dft
 - Mock PluginApi captures tools (same pattern as oc-session-guard).
 * - Tools execute pure functions on params — no network, no file I/O.
 * - Telegram I/O is injectable and not exercised here.
 */
import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-topic-manager/src/index.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createMockApi() {
  const tools: CapturedTool[] = [];
  const logs: string[] = [];
  const api = {
    on: () => {},
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(`ERR ${msg}`),
      warn: () => {},
    },
  };
  return { api, tools, logs };
}

describe("oc-topic-manager tools", () => {
  it("registers topic_audit and topic_recover", () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never);
    const names = tools.map((t) => t.name);
    expect(names).toContain("topic_audit");
    expect(names).toContain("topic_recover");
  });

  it("topic_audit returns an orphan report", async () => {
    const captured: CapturedTool[] = [];
    plugin.register({ registerTool: (t: CapturedTool) => captured.push(t) } as never);
    const audit = captured.find((t) => t.name === "topic_audit")!;
    const result = (await audit.execute("test", {
      topics: [
        { message_thread_id: 1, title: "General", message_count: 5 },
        { message_thread_id: 82385, title: "Flow agent", message_count: 10 },
      ],
      registrations: [{ topicId: 1, sessionKey: "agent:main:telegram:group:-100:topic:1" }],
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    const report = JSON.parse(result.content[0].text);
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0].id).toBe(82385);
    expect(report.unregistered).toHaveLength(0);
  });

  it("topic_recover returns a registration plan", async () => {
    const captured: CapturedTool[] = [];
    plugin.register({ registerTool: (t: CapturedTool) => captured.push(t) } as never);
    const recover = captured.find((t) => t.name === "topic_recover")!;
    const result = (await recover.execute("test", {
      topicId: 82385,
      title: "Flow agent",
      chatId: "-1003842172831",
      agentId: "main",
    })) as { content: Array<{ type: string; text: string }> };
    const plan = JSON.parse(result.content[0].text);
    expect(plan.sessionKey).toBe(
      "agent:main:telegram:group:-1003842172831:topic:82385"
    );
    expect(plan.action).toBe("register");
  });

  it("topic_recover rejects a bad topicId", async () => {
    const captured: CapturedTool[] = [];
    plugin.register({ registerTool: (t: CapturedTool) => captured.push(t) } as never);
    const recover = captured.find((t) => t.name === "topic_recover")!;
    const result = (await recover.execute("test", {
      topicId: "nonsense",
      chatId: "-100",
      agentId: "main",
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toMatch(/invalid/i);
  });
});