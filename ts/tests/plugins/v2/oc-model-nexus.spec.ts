/**
 * Unified Engine Suite: oc-model-nexus (Plugins v2) — Protocol-Double Verification.
 *
 * @dft Uses InMemoryPluginApi (Axiom A5) — zero vi.fn() mocks.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-model-nexus/src/index.js";
import { InMemoryPluginApi } from "../../doubles/in-memory-plugin-api.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Unified Engine: oc-model-nexus (Plugins v2)", () => {
  it("conforms bidirectionally with openclaw.plugin.json manifest contracts", () => {
    const manifestPath = resolve(
      __dirname,
      "../../../src/plugins/v2/oc-model-nexus/openclaw.plugin.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    expect(manifest.contracts.hooks.sort()).toEqual(api.registeredHookNames());
    expect(manifest.contracts.tools.sort()).toEqual(api.registeredToolNames());
  });

  it("records model calls and reports latency, error, relay, and passive cache telemetry", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { minSamples: 2 });

    await api.dispatchHook("model_call_ended", {
      callId: "call-1",
      model: "openai/gpt-4o",
      durationMs: 120,
      success: true,
      usage: { cacheReadTokens: 500 },
    });
    await api.dispatchHook("model_call_ended", {
      callId: "call-2",
      model: "openai/gpt-4o",
      durationMs: 150,
      success: true,
    });
    await api.dispatchHook("model_call_ended", {
      callId: "call-3",
      model: "openai/gpt-4o",
      durationMs: 400,
      success: false,
      error: "timeout",
    });

    const health = JSON.parse((await api.executeTool("model_health")).content[0].text);
    expect(health.totalModels).toBe(1);
    expect(health.models[0].totalCalls).toBe(3);
    expect(health.models[0].errorRate).toBeCloseTo(0.333, 2);

    const relay = JSON.parse((await api.executeTool("stream_relay_health")).content[0].text);
    expect(relay.started).toBe(true);
    expect(relay.totalRelayed).toBe(3);
    expect(relay.totalFailed).toBe(1);

    const cache = JSON.parse((await api.executeTool("context_cache_stats")).content[0].text);
    expect(cache.cacheSize).toBe(0);
    expect(cache.ttlMs).toBe(300000);
    expect(cache.providerTelemetry.providerCacheReadTokens).toBe(500);

    await api.dispatchHook("gateway_stop");
  });
});
