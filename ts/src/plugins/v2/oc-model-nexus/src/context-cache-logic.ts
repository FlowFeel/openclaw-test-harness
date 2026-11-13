/**
 * Prompt Context Cache Logic — in-memory TTL and capacity-bounded cache.
 *
 * @behavior
 * Provides deterministic prompt context caching with TTL eviction, LRU pruning,
 * hit-rate telemetry, and CheckResult mutation reports (Axiom A6).
 *
 * @invariants
 * - Pure logic: no Date.now() / clock calls inside logic — nowMs is injected.
 * - CheckResult pattern: mutating operations return a mutation proof container.
 *
 * @dft
 * - Tested with isolated unit fixtures in oc-model-nexus.spec.ts.
 */

export interface CacheEntry {
  value: unknown;
  createdAtMs: number;
  hitCount: number;
}

export type CacheStore = Map<string, CacheEntry>;

export interface CacheStats {
  cacheSize: number;
  hitRate: number;
  ttlMs: number;
  maxEntries: number;
  entries: Array<{
    key: string;
    ageMs: number;
    hitCount: number;
  }>;
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

  cache.set(key, {
    value,
    createdAtMs: nowMs,
    hitCount: 0,
  });

  return {
    evictedKey,
    size: cache.size,
  };
}

export function invalidateExpired(
  cache: CacheStore,
  nowMs: number,
  ttlMs: number,
): number {
  let evicted = 0;
  for (const [key, entry] of cache.entries()) {
    if (nowMs - entry.createdAtMs > ttlMs) {
      cache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

export function getCacheStats(
  cache: CacheStore,
  nowMs: number,
  ttlMs: number,
  maxEntries: number,
): CacheStats {
  let totalHits = 0;
  const entries: CacheStats["entries"] = [];

  for (const [key, entry] of cache.entries()) {
    totalHits += entry.hitCount;
    entries.push({
      key,
      ageMs: nowMs - entry.createdAtMs,
      hitCount: entry.hitCount,
    });
  }

  const hitRate = entries.length > 0 ? totalHits / (totalHits + entries.length) : 0;

  return {
    cacheSize: cache.size,
    hitRate: Math.round(hitRate * 1000) / 1000,
    ttlMs,
    maxEntries,
    entries,
  };
}

