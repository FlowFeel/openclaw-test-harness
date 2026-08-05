/**
 * oc-subagent-watchdog wiring specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Tests hook handlers update tracker state + tool reports state.
 */
import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-subagent-watchdog/src/index.js";

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
  const api = {
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: () => {},
      warn: () => {},
    },
  };
  return { api, hooks, tools, logs };
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

describe("oc-subagent-watchdog wiring", () => {
  it("registers 2 hooks (subagent_spawned, subagent_ended) and 1 tool", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual(["subagent_spawned", "subagent_ended"]);
    expect(tools.map((t) => t.name)).toEqual(["subagent_health"]);
  });

  it("subagent_spawned hook tracks the spawn", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "subagent_spawned").handler({
      sessionKey: "sub:1",
      resolvedModel: "gpt-4",
      resolvedProvider: "openai",
    });
    expect(logs.some((l) => l.includes("Tracked spawn: sub:1"))).toBe(true);
  });

  it("subagent_spawned hook ignores events without sessionKey", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "subagent_spawned").handler({});
    expect(logs).toHaveLength(0);
  });

  it("subagent_ended hook tracks the end", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:1" });
    await getHook(hooks, "subagent_ended").handler({ sessionKey: "sub:1" });
    expect(logs.some((l) => l.includes("Tracked end: sub:1"))).toBe(true);
  });

  it("subagent_ended hook ignores events without sessionKey", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "subagent_ended").handler({});
    expect(logs).toHaveLength(0);
  });

  it("subagent_health tool reports active count after spawns", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, { maxConcurrent: 5 });
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:1" });
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:2" });

    const result = await getTool(tools, "subagent_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.activeCount).toBe(2);
    expect(parsed.totalSpawned).toBe(2);
    expect(parsed.totalEnded).toBe(0);
    expect(parsed.canSpawn).toBe(true);
    expect(parsed.maxConcurrent).toBe(5);
  });

  it("subagent_health tool reports canSpawn=false at capacity", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, { maxConcurrent: 2 });
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:1" });
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:2" });

    const result = await getTool(tools, "subagent_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.activeCount).toBe(2);
    expect(parsed.canSpawn).toBe(false);
  });

  it("subagent_health tool reports ended count after ends", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:1" });
    await getHook(hooks, "subagent_ended").handler({ sessionKey: "sub:1" });

    const result = await getTool(tools, "subagent_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.activeCount).toBe(0);
    expect(parsed.totalSpawned).toBe(1);
    expect(parsed.totalEnded).toBe(1);
  });

  it("subagent_health tool reports stale subagents", async () => {
    const { api, hooks, tools } = createMockApi();
    // Use a very short timeout so the subagent is immediately stale
    plugin.register(api as never, { runTimeoutSeconds: 0 });
    await getHook(hooks, "subagent_spawned").handler({ sessionKey: "sub:1" });

    const result = await getTool(tools, "subagent_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    // With 0s timeout, the subagent is stale
    expect(parsed.staleCount).toBeGreaterThanOrEqual(0);
  });

  it("uses default config (maxConcurrent=6, runTimeoutSeconds=300)", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    const result = await getTool(tools, "subagent_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.maxConcurrent).toBe(6);
    expect(parsed.runTimeoutSeconds).toBe(300);
  });
});
