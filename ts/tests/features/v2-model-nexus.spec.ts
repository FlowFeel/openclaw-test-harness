/**
 * Tier 3 BDD Spec: v2-model-nexus.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemoryPluginApi.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-model-nexus/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";

describe("Feature: Plugins v2 Model Nexus — Active Routing, Stream Relay & Passive Cache Telemetry", () => {
  it("Scenario: Degraded model triggers fallback recommendation to fastest healthy model", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { minSamples: 2, p99ThresholdMs: 500 });

    await api.dispatchHook("model_call_ended", {
      callId: "a1",
      model: "slow/model-a",
      durationMs: 900,
      success: true,
    });
    await api.dispatchHook("model_call_ended", {
      callId: "a2",
      model: "slow/model-a",
      durationMs: 950,
      success: false,
      error: "timeout",
    });
    await api.dispatchHook("model_call_ended", {
      callId: "b1",
      model: "fast/model-b",
      durationMs: 100,
      success: true,
    });
    await api.dispatchHook("model_call_ended", {
      callId: "b2",
      model: "fast/model-b",
      durationMs: 110,
      success: true,
    });

    const health = JSON.parse((await api.executeTool("model_health")).content[0].text);
    const slow = health.models.find((m: { model: string }) => m.model === "slow/model-a");
    expect(slow.status).toBe("critical");
    expect(health.recommendedFallback).toBe("fast/model-b");
    await api.dispatchHook("gateway_stop");
  });

  it("Scenario: Stream relay enters fallback mode after consecutive failures", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { maxRetries: 2, fallbackEnabled: true });

    await api.dispatchHook("model_call_ended", {
      callId: "f1",
      model: "m1",
      durationMs: 200,
      success: false,
      error: "502",
    });
    await api.dispatchHook("model_call_ended", {
      callId: "f2",
      model: "m1",
      durationMs: 200,
      success: false,
      error: "502",
    });

    const relay = JSON.parse((await api.executeTool("stream_relay_health")).content[0].text);
    expect(relay.fallbackMode).toBe(true);
    expect(relay.fallbackCount).toBe(1);
    await api.dispatchHook("gateway_stop");
  });

  it("Scenario: Context cache stats passively observes provider cache tokens without mutating cache store", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    await api.dispatchHook("model_call_ended", {
      callId: "c1",
      model: "m1",
      durationMs: 100,
      success: true,
      usage: { cacheReadTokens: 1024, cacheWriteTokens: 0 },
    });

    const stats = JSON.parse((await api.executeTool("context_cache_stats")).content[0].text);
    expect(stats.cacheSize).toBe(0);
    expect(stats.providerTelemetry.providerCacheReadTokens).toBe(1024);
    await api.dispatchHook("gateway_stop");
  });
});

