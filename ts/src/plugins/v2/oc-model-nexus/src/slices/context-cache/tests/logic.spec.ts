/**
 * Tier 1 Unit Spec: oc-model-nexus / context-cache slice.
 *
 * @dft Pure unit tests — verifies passive provider telemetry + deterministic TTL cache helpers.
 */

import { describe, it, expect } from "vitest";
import { createContextCacheState } from "../state.js";
import {
  getCached,
  putCached,
  invalidateExpired,
  observeProviderCacheUsage,
  getCacheStats,
} from "../logic.js";

describe("oc-model-nexus / slices/context-cache (Tier 1 Unit)", () => {
  it("passively observes provider cache hits without mutating cache store", () => {
    let state = createContextCacheState(300000, 100);
    const r1 = observeProviderCacheUsage(state, {
      usage: { cacheReadTokens: 1200, cacheWriteTokens: 400 },
    });
    state = r1.nextState;
    expect(r1.hitObserved).toBe(true);
    expect(state.store.size).toBe(0);

    const stats = getCacheStats(state, 1000);
    expect(stats.providerTelemetry.observedCalls).toBe(1);
    expect(stats.providerTelemetry.providerCacheHits).toBe(1);
    expect(stats.providerTelemetry.providerCacheReadTokens).toBe(1200);
  });

  it("manages TTL eviction and capacity bounds with CheckResult proofs", () => {
    const state = createContextCacheState(5000, 2);
    const now = 100000;
    expect(putCached(state.store, "k1", "v1", now, 2)).toEqual({ evictedKey: undefined, size: 1 });
    expect(putCached(state.store, "k2", "v2", now, 2)).toEqual({ evictedKey: undefined, size: 2 });
    expect(putCached(state.store, "k3", "v3", now, 2)).toEqual({ evictedKey: "k1", size: 2 });

    expect(getCached(state.store, "k3", now + 1000, 5000)).toBe("v3");
    expect(getCached(state.store, "k2", now + 6000, 5000)).toBeUndefined();
    expect(invalidateExpired(state.store, now + 10000, 5000)).toBe(1);
    expect(state.store.size).toBe(0);
  });
});
