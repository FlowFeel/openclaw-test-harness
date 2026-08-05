/**
 * oc-context-cache manifest + structure + behavior tests.
 *
 * @behavior
 * - Manifest declares the plugin, tool contract, and startup activation
 * - Plugin registers 3 hooks with correct names
 * - Plugin registers 1 tool (context_cache_stats)
 * - context_cache_stats returns valid JSON with cache stats
 * - Pure logic functions are exported and testable
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { getCached, putCached, invalidateExpired, getCacheStats } from
  "../../../src/plugins/oc-context-cache/src/index.js";

describe("oc-context-cache plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-context-cache");

  // ── Manifest Structure ──────────────────────────────────────────────

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("package.json exists", () => {
    expect(existsSync(resolve(pluginDir, "package.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"),
  );

  it("declares context_cache_stats tool", () => {
    expect(manifest.contracts.tools).toContain("context_cache_stats");
  });

  it("activates on startup", () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  it("has configSchema with ttlMs default 300000 and maxEntries default 100", () => {
    const props = manifest.configSchema.properties;
    expect(props.ttlMs.default).toBe(300000);
    expect(props.maxEntries.default).toBe(100);
  });

  // ── Plugin Registration Behavior ────────────────────────────────────

  it("registers 3 hooks (before_prompt_build, gateway_start, gateway_stop) with correct names", async () => {
    const registeredHooks: Array<{ event: string | string[]; name: string }> = [];

    const mockApi = {
      logger: {
        info: () => {},
        error: () => {},
      },
      on: (events: string, _handler: Function, opts?: { name?: string }) => {
        registeredHooks.push({ event: events, name: opts?.name ?? "" });
      },
      registerHook: (
        events: string | string[],
        _handler: Function,
        opts?: { name?: string },
      ) => {
        registeredHooks.push({ event: events, name: opts?.name ?? "" });
      },
      registerTool: () => {},
    };

    // Load the plugin module and register
    const mod = await import(
      "../../../src/plugins/oc-context-cache/src/index.js"
    );
    const plugin = mod.default;
    plugin.register(mockApi as any);

    // Should have 3 hooks
    expect(registeredHooks).toHaveLength(3);

    // Find hooks by event name (api.on uses hook name directly, no opts.name)
    const beforePrompt = registeredHooks.find(
      (h) => h.event === "before_prompt_build",
    );
    const gatewayStart = registeredHooks.find(
      (h) => h.event === "gateway_start",
    );
    const gatewayStop = registeredHooks.find(
      (h) => h.event === "gateway_stop",
    );

    expect(beforePrompt).toBeDefined();
    expect(gatewayStart).toBeDefined();
    expect(gatewayStop).toBeDefined();
  });

  it("registers 1 tool (context_cache_stats)", async () => {
    const registeredTools: Array<{ name: string }> = [];

    const mockApi = {
      logger: {
        info: () => {},
        error: () => {},
      },
      on: () => {},
      registerHook: () => {},
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
    };

    const mod = await import(
      "../../../src/plugins/oc-context-cache/src/index.js"
    );
    const plugin = mod.default;
    plugin.register(mockApi as any);

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("context_cache_stats");
  });

  it("context_cache_stats returns valid JSON with cacheSize, hitRate, ttlMs", async () => {
    let registeredTool: { name: string; execute: Function } | undefined;

    const mockApi = {
      logger: {
        info: () => {},
        error: () => {},
      },
      on: () => {},
      registerHook: () => {},
      registerTool: (tool: { name: string; execute: Function }) => {
        registeredTool = tool;
      },
    };

    const mod = await import(
      "../../../src/plugins/oc-context-cache/src/index.js"
    );
    const plugin = mod.default;
    plugin.register(mockApi as any);

    expect(registeredTool).toBeDefined();

    const result = await registeredTool!.execute("test-id", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("cacheSize");
    expect(parsed).toHaveProperty("hitRate");
    expect(parsed).toHaveProperty("ttlMs");
    expect(parsed).toHaveProperty("maxEntries");
    expect(parsed).toHaveProperty("entries");
    expect(typeof parsed.cacheSize).toBe("number");
    expect(typeof parsed.hitRate).toBe("number");
    expect(typeof parsed.ttlMs).toBe("number");
  });

  // ── Pure Logic: getCached / putCached / invalidateExpired / getCacheStats ──

  describe("pure logic", () => {
    it("putCached stores a value and getCached retrieves it", () => {
      const cache = new Map();
      const now = 1000;
      const ttl = 500;

      putCached(cache, "key1", "hello", now);
      const result = getCached(cache, "key1", now, ttl);

      expect(result).toBe("hello");
    });

    it("getCached returns undefined for missing key", () => {
      const cache = new Map();
      const now = 1000;
      const ttl = 500;

      const result = getCached(cache, "nonexistent", now, ttl);
      expect(result).toBeUndefined();
    });

    it("getCached returns undefined for expired entry", () => {
      const cache = new Map();
      const ttl = 100;
      const createdAt = 0;
      const now = 200; // 200ms after creation, TTL is 100ms

      putCached(cache, "key1", "value", createdAt);
      const result = getCached(cache, "key1", now, ttl);

      expect(result).toBeUndefined();
      expect(cache.has("key1")).toBe(false); // removed on expiry
    });

    it("getCached increments hitCount on successful retrieval", () => {
      const cache = new Map();
      const now = 1000;
      const ttl = 500;

      putCached(cache, "key1", "value", now);
      getCached(cache, "key1", now, ttl);
      getCached(cache, "key1", now, ttl);

      expect(cache.get("key1")!.hitCount).toBe(2);
    });

    it("invalidateExpired removes only expired entries", () => {
      const cache = new Map();
      const ttl = 100;
      const now = 500;

      putCached(cache, "fresh", "val1", 450); // age 50ms
      putCached(cache, "stale", "val2", 100); // age 400ms

      const removed = invalidateExpired(cache, now, ttl);

      expect(removed).toBe(1);
      expect(cache.has("fresh")).toBe(true);
      expect(cache.has("stale")).toBe(false);
    });

    it("getCacheStats returns correct stats", () => {
      const cache = new Map();
      const now = 1000;
      const ttl = 500;
      const maxEntries = 100;

      putCached(cache, "a", 1, 800);
      putCached(cache, "b", 2, 900);

      // Hit "a" twice
      getCached(cache, "a", now, ttl);
      getCached(cache, "a", now, ttl);

      const stats = getCacheStats(cache, now, ttl, maxEntries);

      expect(stats.cacheSize).toBe(2);
      expect(stats.hitRate).toBe(1); // 2 hits / 2 accesses = 1.0
      expect(stats.ttlMs).toBe(500);
      expect(stats.maxEntries).toBe(100);
      expect(stats.entries).toHaveLength(2);

      const entryA = stats.entries.find((e) => e.key === "a");
      expect(entryA).toBeDefined();
      expect(entryA!.hitCount).toBe(2);
      expect(entryA!.ageMs).toBe(200);

      const entryB = stats.entries.find((e) => e.key === "b");
      expect(entryB).toBeDefined();
      expect(entryB!.hitCount).toBe(0);
      expect(entryB!.ageMs).toBe(100);
    });
  });
});