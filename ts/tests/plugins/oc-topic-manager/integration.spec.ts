/**
 * oc-topic-manager integration specs — fires tools through a mock PluginApi.
 *
 * @dft
 - Mock PluginApi captures tools (same pattern as oc-session-guard).
 * - Tools execute pure functions on params — no network.
 * - Registry round-trip uses a real temp file (the one honest way to prove
 *   read → apply → persist); Telegram network I/O stays unexercised.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const report = JSON.parse(result.content[0].text) as {
      orphaned: Array<{ id: number }>;
      unregistered: unknown[];
      archivalDecisions: Array<{ topicId: number; action: string; reason: string }>;
    };
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0].id).toBe(82385);
    expect(report.unregistered).toHaveLength(0);
    // Archival decisions are surfaced for every topic in the payload.
    expect(report.archivalDecisions).toHaveLength(2);
    // Bot API payloads carry no last-activity field — the idle rule must be
    // visibly unevaluated, not silently "within thresholds".
    const general = report.archivalDecisions.find((d) => d.topicId === 1);
    expect(general?.action).toBe("leave");
    expect(general?.reason).toMatch(/unknown/i);
  });

  it("topic_audit evaluates the idle rule when the source supplies lastActiveAt", async () => {
    const captured: CapturedTool[] = [];
    plugin.register({ registerTool: (t: CapturedTool) => captured.push(t) } as never);
    const audit = captured.find((t) => t.name === "topic_audit")!;
    const result = (await audit.execute("test", {
      topics: [
        { message_thread_id: 1, title: "Stale", message_count: 5, lastActiveAt: "2026-01-01T00:00:00Z" },
        { message_thread_id: 2, title: "Fat", message_count: 5000, lastActiveAt: "2026-09-06T00:00:00Z" },
      ],
      registrations: [],
    })) as { content: Array<{ type: string; text: string }> };
    const report = JSON.parse(result.content[0].text) as {
      archivalDecisions: Array<{ topicId: number; action: string; reason: string }>;
    };
    const byId = new Map(report.archivalDecisions.map((d) => [d.topicId, d] as const));
    expect(byId.get(1)?.action).toBe("archive");
    expect(byId.get(1)?.reason).toMatch(/idle/i);
    expect(byId.get(2)?.action).toBe("compact");
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

  describe("with a real temp registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-topic-mgr-"));
    const registryPath = join(dir, "sessions.json");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const capture = () => {
      const captured: CapturedTool[] = [];
      plugin.register({ registerTool: (t: CapturedTool) => captured.push(t) } as never);
      return {
        audit: captured.find((t) => t.name === "topic_audit")!,
        recover: captured.find((t) => t.name === "topic_recover")!,
      };
    };

    const readRegistry = (): Record<string, unknown> =>
      JSON.parse(readFileSync(registryPath, "utf8"));

    it("topic_audit reads registrations from the registry when omitted", async () => {
      writeFileSync(
        registryPath,
        JSON.stringify({
          "agent:main:telegram:group:-1003842172831:topic:1": { model: "x" },
        })
      );
      const { audit } = capture();
      const result = (await audit.execute("test", {
        topics: [{ message_thread_id: 82385, title: "Flow agent", message_count: 10 }],
        sessionsPath: registryPath,
      })) as { content: Array<{ type: string; text: string }> };
      const report = JSON.parse(result.content[0].text);
      expect(report.orphaned.map((t: { id: number }) => t.id)).toEqual([82385]);
    });

    it("topic_recover apply=true registers the orphan; audit then sees it healthy", async () => {
      const { audit, recover } = capture();
      const result = (await recover.execute("test", {
        topicId: 82385,
        chatId: "-1003842172831",
        agentId: "main",
        apply: true,
        sessionsPath: registryPath,
      })) as { content: Array<{ type: string; text: string }> };
      const out = JSON.parse(result.content[0].text);
      expect(out.plan.sessionKey).toBe(
        "agent:main:telegram:group:-1003842172831:topic:82385"
      );
      expect(out.application).toMatchObject({
        applied: true,
        created: true,
        before: "absent",
        after: "registered",
      });
      // The registry on disk now contains the entry with an ISO timestamp.
      const registry = readRegistry();
      const entry = registry["agent:main:telegram:group:-1003842172831:topic:82385"] as {
        registeredAt?: string;
      };
      expect(entry).toBeDefined();
      expect(entry.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // The closed loop: a follow-up audit reports zero orphans.
      const recheck = (await audit.execute("test", {
        topics: [{ message_thread_id: 82385, title: "Flow agent", message_count: 10 }],
        sessionsPath: registryPath,
      })) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(recheck.content[0].text).orphaned).toHaveLength(0);
    });

    it("topic_recover apply=true is idempotent — existing entries are preserved", async () => {
      const { recover } = capture();
      const result = (await recover.execute("test", {
        topicId: 82385,
        chatId: "-1003842172831",
        agentId: "main",
        apply: true,
        sessionsPath: registryPath,
      })) as { content: Array<{ type: string; text: string }> };
      const out = JSON.parse(result.content[0].text);
      expect(out.application.applied).toBe(false);
      expect(out.application.reason).toMatch(/already registered/i);
      // The original entry (with its first-write timestamp) is untouched.
      const registry = readRegistry();
      expect(registry["agent:main:telegram:group:-1003842172831:topic:82385"]).toBeDefined();
    });
  });
});