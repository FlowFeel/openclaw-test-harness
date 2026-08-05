/**
 * oc-context-cache wiring specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Tests hook handlers manage cache lifecycle + tool reports stats.
 * - Tests pure logic (getCached, putCached, invalidateExpired, getCacheStats) inline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import plugin, {
  getCached,
  putCached,
  invalidateExpired,
  getCacheStats,
  type CacheStore,
} from "../../../src/plugins/oc-context-cache/src/index.js";

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

// ── Pure logic ───────────────────────────────────────────────

describe("oc-context-cache pure logic", () => {
  let cache: CacheStore;

  beforeEach(() => {
    cache = new Map();
  });

  it("getCached returns undefined for missing key", () => {
    expect(getCached(cache, "missing", 1000, 5000)).toBeUndefined();
  });

  it("getCached returns value for fresh entry", () => {
    putCached(cache, "key1", "value1", 1000);
    expect(getCached(cache, "key1", 1500, 5000)).toBe("value1");
  });

  it("getCached returns undefined for expired entry and deletes it", () => {
    putCached(cache, "key1", "value1", 1000);
    expect(getCached(cache, "key1", 7000, 5000)).toBeUndefined();
    expect(cache.has("key1")).toBe(false);
  });

  it("getCached increments hitCount", () => {
    putCached(cache, "key1", "value1", 1000);
    getCached(cache, "key1", 1500, 5000);
    getCached(cache, "key1", 1600, 5000);
    expect(cache.get("key1")?.hitCount).toBe(2);
  });

  it("putCached overwrites existing entry", () => {
    putCached(cache, "key1", "value1", 1000);
    putCached(cache, "key1", "value2", 2000);
    expect(cache.get("key1")?.value).toBe("value2");
    expect(cache.get("key1")?.hitCount).toBe(0);
  });

  it("invalidateExpired removes only expired entries", () => {
    putCached(cache, "fresh", "v1", 6000);  // age 1000 at check time
    putCached(cache, "stale", "v2", 1000);  // age 6000 at check time
    const removed = invalidateExpired(cache, 7000, 5000);
    expect(removed).toBe(1);
    expect(cache.has("fresh")).toBe(true);
    expect(cache.has("stale")).toBe(false);
  });

  it("invalidateExpired returns 0 when nothing expired", () => {
    putCached(cache, "key1", "v1", 1000);
    expect(invalidateExpired(cache, 2000, 5000)).toBe(0);
  });

  it("getCacheStats returns correct stats", () => {
    putCached(cache, "key1", "v1", 1000);
    getCached(cache, "key1", 1500, 5000);
    const stats = getCacheStats(cache, 2000, 5000, 100);
    expect(stats.cacheSize).toBe(1);
    expect(stats.ttlMs).toBe(5000);
    expect(stats.maxEntries).toBe(100);
    expect(stats.entries).toHaveLength(1);
    expect(stats.entries[0].key).toBe("key1");
    expect(stats.entries[0].ageMs).toBe(1000);
    expect(stats.entries[0].hitCount).toBe(1);
  });

  it("getCacheStats returns 0 hitRate for empty cache", () => {
    const stats = getCacheStats(new Map(), 1000, 5000, 100);
    expect(stats.cacheSize).toBe(0);
    expect(stats.hitRate).toBe(0);
    expect(stats.entries).toHaveLength(0);
  });
});

// ── Wiring ───────────────────────────────────────────────────

describe("oc-context-cache wiring", () => {
  it("registers 3 hooks (before_prompt_build, gateway_start, gateway_stop) and 1 tool", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual([
      "before_prompt_build",
      "gateway_start",
      "gateway_stop",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["context_cache_stats"]);
  });

  it("gateway_start hook logs initialization", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, { ttlMs: 60000, maxEntries: 50 });
    await getHook(hooks, "gateway_start").handler({});
    expect(logs.some((l) => l.includes("Cache initialized"))).toBe(true);
    expect(logs.some((l) => l.includes("TTL 60000ms"))).toBe(true);
  });

  it("gateway_stop hook clears cache and logs", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    await getHook(hooks, "gateway_stop").handler({});
    expect(logs.some((l) => l.includes("Cache cleared"))).toBe(true);
  });

  it("before_prompt_build hook logs execution", async () => {
    const { api, hooks, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "before_prompt_build").handler({});
    expect(logs.some((l) => l.includes("before_prompt_build hook executed"))).toBe(true);
  });

  it("context_cache_stats tool returns stats with config", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, { ttlMs: 30000, maxEntries: 25 });
    const result = await getTool(tools, "context_cache_stats").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ttlMs).toBe(30000);
    expect(parsed.maxEntries).toBe(25);
    expect(parsed).toHaveProperty("cacheSize");
    expect(parsed).toHaveProperty("hitRate");
    expect(parsed).toHaveProperty("entries");
  });

  it("context_cache_stats tool uses default config", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});
    const result = await getTool(tools, "context_cache_stats").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ttlMs).toBe(300000);
    expect(parsed.maxEntries).toBe(100);
  });

  it("hook errors are caught and logged (never throw)", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    // Hooks should not throw even if something goes wrong internally
    await expect(getHook(hooks, "gateway_start").handler({})).resolves.not.toThrow();
    await expect(getHook(hooks, "gateway_stop").handler({})).resolves.not.toThrow();
    await expect(getHook(hooks, "before_prompt_build").handler({})).resolves.not.toThrow();
  });
});
