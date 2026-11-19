/**
 * Tier 2 Integration Spec: oc-model-nexus (Stateful Protocol Doubles, Axiom A5).
 *
 * @dft Zero vi.fn() shims — uses InMemoryPluginApi and deterministic TelemetrySampler.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../src/index.js";
import { InMemoryPluginApi } from "../../../../../tests/doubles/in-memory-plugin-api.js";
import type { TelemetrySampler } from "../src/slices/event-loop/io.js";

class InMemoryTelemetrySampler implements TelemetrySampler {
  samples = 0;
  disposed = false;
  sample(actorId: string) {
    this.samples += 1;
    return {
      actorId,
      eventLoopP99Ms: 12,
      eventLoopUtilization: 0.15,
      usedHeapSize: 90 * 1024 * 1024,
      cpuRatio: 0.12,
    };
  }
  dispose() {
    this.disposed = true;
  }
}

describe("oc-model-nexus (Tier 2 Integration)", () => {
  it("routes model call outcomes across routing, relay, event-loop, and passive cache slices", async () => {
    const api = new InMemoryPluginApi();
    const sampler = new InMemoryTelemetrySampler();
    let now = 10000;
    pluginDef.register(api, {
      minSamples: 2,
      telemetrySampler: sampler,
      clock: () => now,
    });

    await api.dispatchHook("model_call_started", { callId: "c1", model: "openai/gpt-4o" });
    await api.dispatchHook("model_call_ended", {
      callId: "c1",
      model: "openai/gpt-4o",
      durationMs: 120,
      success: true,
      usage: { cacheReadTokens: 800, cacheWriteTokens: 0 },
    });
    await api.dispatchHook("model_call_ended", {
      callId: "c2",
      model: "openai/gpt-4o",
      durationMs: 400,
      success: false,
      error: "timeout",
    });

    const health = JSON.parse((await api.executeTool("model_health")).content[0].text);
    expect(health.totalModels).toBe(1);
    expect(health.models[0].totalCalls).toBe(2);
    expect(health.models[0].errorRate).toBe(0.5);

    now += 5000;
    const relay = JSON.parse((await api.executeTool("stream_relay_health")).content[0].text);
    expect(relay.totalRelayed).toBe(2);
    expect(relay.totalFailed).toBe(1);
    expect(relay.uptimeSeconds).toBe(5);

    const cache = JSON.parse((await api.executeTool("context_cache_stats")).content[0].text);
    expect(cache.cacheSize).toBe(0);
    expect(cache.providerTelemetry.observedCalls).toBe(2);
    expect(cache.providerTelemetry.providerCacheHits).toBe(1);
    expect(cache.providerTelemetry.providerCacheReadTokens).toBe(800);

    const loop = JSON.parse((await api.executeTool("event_loop_health")).content[0].text);
    expect(loop.status).toBe("healthy");
    expect(sampler.samples).toBe(1);

    await api.dispatchHook("gateway_stop");
    expect(sampler.disposed).toBe(true);
  });
});
