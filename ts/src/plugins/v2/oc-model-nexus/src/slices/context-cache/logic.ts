/**
 * Context Cache Pure Logic — passive provider cache telemetry observer plus pure TTL cache helpers.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), CheckResult returns on all transitions (A1, A2, A6).
 * - observeProviderCacheUsage is strictly read-only on model usage telemetry; never mutates prompts.
 *
 * @dft
 * - Tested in slices/context-cache/tests/logic.spec.ts.
 */

import type { HookEvent } from "../../../../../shared/types.js";
import type { CacheStore, ContextCacheSliceState, ProviderCacheTelemetry } from "./state.js";

export interface CacheStats {
  cacheSize: number;
  hitRate: number;
  ttlMs: number;
  maxEntries: number;
  entries: Array<{ key: string; ageMs: number; hitCount: number }>;
  providerTelemetry: ProviderCacheTelemetry;
}

export interface CachePutResult {
  evictedKey?: string;
  size: number;
}

export function getCached(
  cache: CacheStore,
  key: string,
  nowMs: number,
  ttlMs: number,
): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (nowMs - entry.createdAtMs > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  entry.hitCount += 1;
  return entry.value;
}

export function putCached(
  cache: CacheStore,
  key: string,
  value: unknown,
  nowMs: number,
  maxEntries: number,
): CachePutResult {
  let evictedKey: string | undefined;
  if (cache.size >= maxEntries && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
      evictedKey = oldestKey;
    }
  }
  cache.set(key, { value, createdAtMs: nowMs, hitCount: 0 });
  return { evictedKey, size: cache.size };
}

export function invalidateExpired(cache: CacheStore, nowMs: number, ttlMs: number): number {
  let evicted = 0;
  for (const [key, entry] of cache.entries()) {
    if (nowMs - entry.createdAtMs > ttlMs) {
      cache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

export function observeProviderCacheUsage(
  state: ContextCacheSliceState,
  event?: HookEvent,
): { nextState: ContextCacheSliceState; hitObserved: boolean } {
  const usage =
    event?.usage && typeof event.usage === "object"
      ? (event.usage as Record<string, unknown>)
      : undefined;
  const readTokens = typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
  const writeTokens = typeof usage?.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0;
  const hitObserved = readTokens > 0;
  const prev = state.providerTelemetry;

  return {
    hitObserved,
    nextState: {
      ...state,
      providerTelemetry: {
        observedCalls: prev.observedCalls + 1,
        providerCacheHits: prev.providerCacheHits + (hitObserved ? 1 : 0),
        providerCacheReadTokens: prev.providerCacheReadTokens + readTokens,
        providerCacheWriteTokens: prev.providerCacheWriteTokens + writeTokens,
      },
    },
  };
}

export function getCacheStats(
  state: ContextCacheSliceState,
  nowMs: number,
): CacheStats {
  let totalHits = 0;
  const entries: CacheStats["entries"] = [];
  for (const [key, entry] of state.store.entries()) {
    totalHits += entry.hitCount;
    entries.push({ key, ageMs: nowMs - entry.createdAtMs, hitCount: entry.hitCount });
  }
  const hitRate = entries.length > 0 ? totalHits / (totalHits + entries.length) : 0;
  return {
    cacheSize: state.store.size,
    hitRate: Math.round(hitRate * 1000) / 1000,
    ttlMs: state.ttlMs,
    maxEntries: state.maxEntries,
    entries,
    providerTelemetry: state.providerTelemetry,
  };
}

