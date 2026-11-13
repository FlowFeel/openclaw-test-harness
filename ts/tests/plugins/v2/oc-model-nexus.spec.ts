import { describe, it, expect, vi, beforeEach } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-model-nexus/src/index.js";
import { resetSharedModelStateForTests } from "../../../src/plugins/v2/oc-model-nexus/src/model-router-logic.js";
import {
  getCached,
  putCached,
  invalidateExpired,
  getCacheStats,
  type CacheStore,
} from "../../../src/plugins/v2/oc-model-nexus/src/context-cache-logic.js";
import {
  shouldRelay,
  shouldRelayFallback,
} from "../../../src/plugins/v2/oc-model-nexus/src/stream-relay-logic.js";
import type { PluginApi, ToolDefinition } from "../../../src/plugins/shared/types.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Unified Engine: oc-model-nexus (Plugins v2)", () => {
  beforeEach(() => {
    resetSharedModelStateForTests();
  });

  function createTestApi() {
    const tools = new Map<string, ToolDefinition>();
    const hooks = new Map<string, Array<(event: any, ctx?: any) => Promise<unknown>>>();

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

  it("conforms bidirectionally with openclaw.plugin.json manifest contracts", () => {
    const manifestPath = resolve(
      __dirname,
      "../../../src/plugins/v2/oc-model-nexus/openclaw.plugin.json"
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const { api, tools, hooks } = createTestApi();
    pluginDef.register(api, {});

    const registeredHooks = Array.from(hooks.keys()).sort();
    const registeredTools = Array.from(tools.keys()).sort();

    expect(manifest.contracts.hooks.sort()).toEqual(registeredHooks);
    expect(manifest.contracts.tools.sort()).toEqual(registeredTools);
  });

  it("registers all 4 consolidated tools and hooks", () => {
    const { api, tools, hooks } = createTestApi();
    pluginDef.register(api, {});

    const expectedTools = [
      "model_health",
      "stream_relay_health",
      "event_loop_health",
      "context_cache_stats",
    ];

    for (const toolName of expectedTools) {
      expect(tools.has(toolName), `Missing tool ${toolName}`).toBe(true);
    }

    expect(hooks.has("model_call_started")).toBe(true);
    expect(hooks.has("model_call_ended")).toBe(true);
    expect(hooks.has("gateway_stop")).toBe(true);
  });

  it("pure context-cache-logic manages TTL, capacity eviction, and hit rate deterministically", () => {
    const store: CacheStore = new Map();
    const now = 1000000;

    // Put two entries with maxEntries=2
    const put1 = putCached(store, "p1", "prompt-one", now, 2);
    expect(put1.size).toBe(1);
    expect(put1.evictedKey).toBeUndefined();

    const put2 = putCached(store, "p2", "prompt-two", now, 2);
    expect(put2.size).toBe(2);

    // Over-capacity put evicts oldest (p1)
    const put3 = putCached(store, "p3", "prompt-three", now, 2);
    expect(put3.size).toBe(2);
    expect(put3.evictedKey).toBe("p1");

    // Hit p3
    const hit = getCached(store, "p3", now + 1000, 5000);
    expect(hit).toBe("prompt-three");

    // Miss on expired p2
    const expiredMiss = getCached(store, "p2", now + 10000, 5000);
    expect(expiredMiss).toBeUndefined();

    // Stats
    const stats = getCacheStats(store, now + 1000, 5000, 2);
    expect(stats.cacheSize).toBe(1);
    expect(stats.hitRate).toBeGreaterThan(0);

    // Invalidation
    const evicted = invalidateExpired(store, now + 20000, 5000);
    expect(evicted).toBe(1);
    expect(store.size).toBe(0);
  });

  it("pure stream-relay-logic determines relay routing and fallback boundaries", () => {
    expect(shouldRelay("openai/gpt-4o", true, false)).toBe(true);
    expect(shouldRelay("openai/gpt-4o", false, true)).toBe(true);
    expect(shouldRelay("openai/gpt-4o", false, false)).toBe(false);
    expect(shouldRelay("", true, true)).toBe(false);

    expect(shouldRelayFallback(false, true, 0, 3)).toBe(true);
    expect(shouldRelayFallback(true, true, 3, 3)).toBe(true);
    expect(shouldRelayFallback(true, true, 1, 3)).toBe(false);
    expect(shouldRelayFallback(false, false, 0, 3)).toBe(false);
  });

  it("records model calls and reports latency / error metrics in model_health", async () => {
    const { api, tools, hooks } = createTestApi();
    pluginDef.register(api, { minSamples: 2 });

    const endHooks = hooks.get("model_call_ended")!;
    expect(endHooks.length).toBeGreaterThan(0);

    // Simulate 3 calls to model A (2 success, 1 failure)
    for (const endHook of endHooks) {
      await endHook({
        callId: "call-1",
        model: "openai/gpt-4o",
        durationMs: 120,
        success: true,
      });
      await endHook({
        callId: "call-2",
        model: "openai/gpt-4o",
        durationMs: 150,
        success: true,
      });
      await endHook({
        callId: "call-3",
        model: "openai/gpt-4o",
        durationMs: 400,
        success: false,
        error: "timeout",
      });
    }

    const healthTool = tools.get("model_health")!;
    const res = await healthTool.execute("call-h", {});
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed.totalModels).toBe(1);
    expect(parsed.models[0].model).toBe("openai/gpt-4o");
    expect(parsed.models[0].totalCalls).toBe(3);
    expect(parsed.models[0].errorRate).toBeCloseTo(0.333, 2);
  });

  it("returns stream_relay_health, event_loop_health, and context_cache_stats", async () => {
    const { api, tools } = createTestApi();
    pluginDef.register(api, {});

    const relayTool = tools.get("stream_relay_health")!;
    const relayRes = await relayTool.execute("c1", {});
    const relayData = JSON.parse(relayRes.content[0].text);
    expect(relayData.started).toBe(true);
    expect(relayData.fallbackMode).toBe(false);

    const eventLoopTool = tools.get("event_loop_health")!;
    const elRes = await eventLoopTool.execute("c2", {});
    const elData = JSON.parse(elRes.content[0].text);
    expect(elData.status).toBeDefined();

    const cacheTool = tools.get("context_cache_stats")!;
    const cacheRes = await cacheTool.execute("c3", {});
    const cacheData = JSON.parse(cacheRes.content[0].text);
    expect(cacheData.cacheSize).toBe(0);
    expect(cacheData.ttlMs).toBe(300000);
  });
});
