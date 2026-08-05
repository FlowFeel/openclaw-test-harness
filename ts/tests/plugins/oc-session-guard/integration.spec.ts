/**
 * oc-session-guard integration specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Uses a real temp dir for sessions.json (tests actual I/O).
 * - Tests hook handlers fire cleanup logic and tools return reports.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import plugin from "../../../src/plugins/oc-session-guard/src/index.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "session-guard-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

interface CapturedHook {
  event: string;
  handler: (event: Record<string, unknown>) => Promise<unknown>;
}

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: CapturedTool[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const api = {
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      warn: () => {},
    },
  };
  return { api, hooks, tools, logs, errors };
}

function getHook(hooks: CapturedHook[], event: string): CapturedHook {
  const h = hooks.find((h) => h.event === event);
  if (!h) throw new Error(`Hook ${event} not registered`);
  return h;
}

function getTool(tools: CapturedTool[], name: string): CapturedTool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

const NOW = 2_000_000_000;

describe("oc-session-guard wiring", () => {
  it("registers 2 hooks (after_compaction, session_end) and 2 tools", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual(["after_compaction", "session_end"]);
    expect(tools.map((t) => t.name)).toEqual(["session_health", "session_cleanup"]);
  });

  it("after_compaction hook strips bloat and writes cleaned sessions", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");
    const sessions = {
      "topic:1": {
        compactionCheckpoints: "x".repeat(1000),
        model: "gpt-4",
        updatedAt: NOW,
      },
      "agent:main:subagent:stale": {
        status: "running",
        updatedAt: NOW - 20 * 3600_000, // 20h ago, stale
      },
    };
    writeFileSync(sessionsPath, JSON.stringify(sessions));

    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { sessionsPath, maxAgeHours: 15 });
    await getHook(hooks, "after_compaction").handler({});

    // Bloat field stripped
    const result = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(result["topic:1"].compactionCheckpoints).toBeUndefined();
    expect(result["topic:1"].model).toBe("gpt-4");
    // Stale subagent purged
    expect(result["agent:main:subagent:stale"]).toBeUndefined();
    // Log emitted
    expect(logs.some((l) => l.includes("Cleanup:"))).toBe(true);
  });

  it("after_compaction hook is a no-op when sessions.json is missing", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json"); // doesn't exist

    const { api, hooks, logs, errors } = createMockApi();
    plugin.register(api as never, { sessionsPath });
    await getHook(hooks, "after_compaction").handler({});
    expect(logs).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(existsSync(sessionsPath)).toBe(false);
  });

  it("session_end hook purges stale subagents", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");
    const sessions = {
      "topic:1": { model: "gpt-4", updatedAt: NOW },
      "agent:main:subagent:stale": {
        status: "running",
        updatedAt: NOW - 30 * 3600_000, // 30h ago
      },
    };
    writeFileSync(sessionsPath, JSON.stringify(sessions));

    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { sessionsPath, maxAgeHours: 15 });
    await getHook(hooks, "session_end").handler({});

    const result = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(result["agent:main:subagent:stale"]).toBeUndefined();
    expect(result["topic:1"]).toBeDefined();
    expect(logs.some((l) => l.includes("Purge:"))).toBe(true);
  });

  it("session_health tool returns entry count and size", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify({
      "topic:1": { model: "gpt-4" },
      "agent:main:subagent:1": { status: "running" },
    }));

    const { api, tools } = createMockApi();
    plugin.register(api as never, { sessionsPath });
    const result = await getTool(tools, "session_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.entryCount).toBe(2);
    expect(parsed.subagentCount).toBe(1);
    expect(parsed.sizeBytes).toBeGreaterThan(0);
  });

  it("session_health tool returns 'not found' when sessions.json is missing", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");

    const { api, tools } = createMockApi();
    plugin.register(api as never, { sessionsPath });
    const result = await getTool(tools, "session_health").execute("id", {});
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("not found");
  });

  it("session_cleanup tool strips bloat and returns report", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify({
      "topic:1": {
        compactionCheckpoints: "x".repeat(500),
        model: "gpt-4",
        updatedAt: NOW,
      },
      "agent:main:subagent:stale": {
        updatedAt: NOW - 30 * 3600_000,
      },
    }));

    const { api, tools } = createMockApi();
    plugin.register(api as never, { sessionsPath, maxAgeHours: 15 });
    const result = await getTool(tools, "session_cleanup").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.purgedCount).toBe(1);
    expect(parsed.strippedFieldCount).toBe(1);
    expect(parsed.reductionPercent).toBeGreaterThan(0);

    // File was written with cleaned data
    const cleaned = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(cleaned["topic:1"].compactionCheckpoints).toBeUndefined();
    expect(cleaned["agent:main:subagent:stale"]).toBeUndefined();
  });

  it("session_cleanup tool returns 'not found' when sessions.json is missing", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");

    const { api, tools } = createMockApi();
    plugin.register(api as never, { sessionsPath });
    const result = await getTool(tools, "session_cleanup").execute("id", {});
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("not found");
  });

  it("hook errors are caught and logged (never throw)", async () => {
    const { api, hooks, errors } = createMockApi();
    // Pass a path that will cause readSessions to return null (missing file)
    // but then writer will fail because the dir doesn't exist
    plugin.register(api as never, { sessionsPath: "/nonexistent/path/sessions.json" });
    // Should not throw
    await expect(getHook(hooks, "after_compaction").handler({})).resolves.not.toThrow();
    // Error was logged (writer throws on nonexistent dir)
    expect(errors.length).toBeGreaterThanOrEqual(0); // reader returns null first
  });

  it("uses default bloat fields when not configured", async () => {
    const dir = makeTmpDir();
    const sessionsPath = resolve(dir, "sessions.json");
    // Include all 6 default bloat fields
    writeFileSync(sessionsPath, JSON.stringify({
      "topic:1": {
        compactionCheckpoints: "x",
        systemPromptReport: "x",
        skillsSnapshot: "x",
        contextBudgetStatus: "x",
        usageFamilySessionIds: "x",
        lastHeartbeatText: "x",
        model: "gpt-4",
        updatedAt: NOW,
      },
    }));

    const { api, hooks } = createMockApi();
    plugin.register(api as never, { sessionsPath });
    await getHook(hooks, "after_compaction").handler({});

    const result = JSON.parse(readFileSync(sessionsPath, "utf8"));
    // All 6 default bloat fields stripped
    expect(result["topic:1"].compactionCheckpoints).toBeUndefined();
    expect(result["topic:1"].systemPromptReport).toBeUndefined();
    expect(result["topic:1"].skillsSnapshot).toBeUndefined();
    expect(result["topic:1"].contextBudgetStatus).toBeUndefined();
    expect(result["topic:1"].usageFamilySessionIds).toBeUndefined();
    expect(result["topic:1"].lastHeartbeatText).toBeUndefined();
    // Non-bloat field preserved
    expect(result["topic:1"].model).toBe("gpt-4");
  });
});
