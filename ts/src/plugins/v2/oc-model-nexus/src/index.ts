/**
 * Unified Model Nexus Engine — Declarative Vertical Slice Composer (Plugins v2).
 *
 * @invariants
 * - Zero closure-trapped mutable state: each slice owns its own immutable state and reducer.
 * - Cross-slice coordination occurs strictly via typed value records (call outcomes).
 * - Zero direct Node I/O, zero empty catch blocks, zero type-erasure seams.
 *
 * @dft
 * - Full 4-tier test pyramid: slice unit tests, Protocol-double integration + manifest tests,
 *   traceable BDD Gherkin features, and containerized E2E boot gate.
 */

import {
  definePluginEntry,
  type PluginApi,
  type HookEvent,
  type HookContext,
} from "../../../shared/types.js";
import { DEFAULT_MODEL_ROUTER_CONFIG } from "./slices/model-routing/state.js";
import { bindModelRoutingSlice } from "./slices/model-routing/slice.js";
import { bindStreamRelaySlice } from "./slices/stream-relay/slice.js";
import { bindEventLoopSlice } from "./slices/event-loop/slice.js";
import { bindContextCacheSlice } from "./slices/context-cache/slice.js";
import type { TelemetrySampler } from "./slices/event-loop/io.js";

export interface ModelNexusConfig {
  p99ThresholdMs?: number;
  errorRateThreshold?: number;
  minSamples?: number;
  maxSamples?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  sidecarPort?: number;
  fallbackEnabled?: boolean;
  maxRetries?: number;
  telemetrySampler?: TelemetrySampler;
  clock?: () => number;
}

export default definePluginEntry({
  id: "oc-model-nexus",
  name: "OC Model Nexus",
  description:
    "Unified Model Nexus Engine (Plugins v2) — consolidates active model routing & failover, sidecar stream relay, event-loop telemetry monitoring, and passive context cache stats.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as ModelNexusConfig) ?? {};
    const clock = cfg.clock ?? (() => Date.now());

    const routing = bindModelRoutingSlice(api, {
      p99ThresholdMs: cfg.p99ThresholdMs ?? DEFAULT_MODEL_ROUTER_CONFIG.p99ThresholdMs,
      errorRateThreshold: cfg.errorRateThreshold ?? DEFAULT_MODEL_ROUTER_CONFIG.errorRateThreshold,
      minSamples: cfg.minSamples ?? DEFAULT_MODEL_ROUTER_CONFIG.minSamples,
      maxSamples: cfg.maxSamples ?? DEFAULT_MODEL_ROUTER_CONFIG.maxSamples,
    });

    const relay = bindStreamRelaySlice(
      api,
      {
        sidecarPort: cfg.sidecarPort ?? 18900,
        fallbackEnabled: cfg.fallbackEnabled ?? true,
        maxRetries: cfg.maxRetries ?? 3,
      },
      clock,
    );

    const eventLoop = bindEventLoopSlice(api, cfg.telemetrySampler);

    const contextCache = bindContextCacheSlice(
      api,
      { ttlMs: cfg.cacheTtlMs ?? 300000, maxEntries: cfg.cacheMaxEntries ?? 100 },
      clock,
    );

    api.on("model_call_started", async (event: HookEvent, ctx?: HookContext) => {
      eventLoop.collect("main");
      routing.onCallStarted(event, ctx);
    });

    api.on("model_call_ended", async (event: HookEvent, ctx?: HookContext) => {
      const outcome = routing.onCallEnded(event, ctx);
      if (outcome.recorded) {
        relay.recordCallOutcome({ success: !outcome.isError, latencyMs: outcome.latencyMs });
      }
      contextCache.observeCallEnded(event);
    });

    api.on("gateway_stop", async () => {
      eventLoop.stop();
    });
  },
});
