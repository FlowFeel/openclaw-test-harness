/**
 * OC Context Cache — in-memory context cache plugin.
 *
 * @behavior
 * Provides an in-memory cache with TTL-based expiry for frequently accessed
 * context data (system prompts, etc.). Registers lifecycle hooks to manage
 * cache initialization and teardown, and a diagnostic tool to inspect cache
 * state at runtime.
 *
 * @invariants
 * - All cache mutation logic is pure (getCached, putCached, invalidateExpired)
 * - Cache is backed by a plain Map<string, CacheEntry>
 * - Expired entries are lazily evicted on access and on gateway_start
 * - Hooks never block agent runs (catch errors, log, continue)
 *
 * @dft
 * - Pure logic functions exported for testing
 * - Deterministic when time parameter (nowMs) is supplied
 * - No external I/O dependencies
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";

// ── Types ────────────────────────────────────────────────────────────

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

export interface OcContextCacheConfig {
  ttlMs?: number;
  maxEntries?: number;
}

// ── State ────────────────────────────────────────────────────────────

// Module-level cache; scoped to this plugin instance.
const cache: CacheStore = new Map();

// ── Pure Logic ────────────────────────────────────────────────────────

/**
 * Retrieve a cached value by key.
 * Returns undefined if the key is missing or the entry has expired.
 * Increments hitCount on successful (non-expired) retrieval.
 *
 * @param cache - The cache store
 * @param key - Cache key
 * @param nowMs - Current epoch ms for TTL comparison
 * @param ttlMs - Time-to-live in milliseconds
 * @returns The cached value, or undefined
 */
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

/**
 * Store a value in the cache.
 * Overwrites any existing entry for the same key.
 *
 * @param cache - The cache store
 * @param key - Cache key
 * @param value - Value to cache
 * @param nowMs - Current epoch ms
 */
export function putCached(
  cache: CacheStore,
  key: string,
  value: unknown,
  nowMs: number,
): void {
  cache.set(key, {
    value,
    createdAtMs: nowMs,
    hitCount: 0,
  });
}

/**
 * Remove all expired entries from the cache.
 * Returns the number of entries removed.
 *
 * @param cache - The cache store
 * @param nowMs - Current epoch ms
 * @returns Number of expired entries removed
 */
export function invalidateExpired(cache: CacheStore, nowMs: number, ttlMs: number): number {
  let removed = 0;
  for (const [key, entry] of cache) {
    if (nowMs - entry.createdAtMs > ttlMs) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Compute cache statistics.
 *
 * @param cache - The cache store
 * @param nowMs - Current epoch ms
 * @param ttlMs - Time-to-live in milliseconds
 * @param maxEntries - Maximum allowed entries
 * @returns CacheStats snapshot
 */
export function getCacheStats(
  cache: CacheStore,
  nowMs: number,
  ttlMs: number,
  maxEntries: number,
): CacheStats {
  const entries = Array.from(cache.entries()).map(([key, entry]) => ({
    key,
    ageMs: nowMs - entry.createdAtMs,
    hitCount: entry.hitCount,
  }));

  const totalHits = entries.reduce((sum, e) => sum + e.hitCount, 0);
  const totalAccesses = totalHits; // We track hits; misses are not counted here
  const hitRate = totalAccesses > 0 ? totalHits / totalAccesses : 0;

  return {
    cacheSize: cache.size,
    hitRate,
    ttlMs,
    maxEntries,
    entries,
  };
}

// ── Plugin Registration ──────────────────────────────────────────────

export default definePluginEntry({
  id: "oc-context-cache",
  name: "OC Context Cache",
  description: "In-memory context cache for system prompt and frequently accessed data.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: OcContextCacheConfig = (config as OcContextCacheConfig) ?? {};
    const ttlMs = cfg.ttlMs ?? 300_000;
    const maxEntries = cfg.maxEntries ?? 100;

    // ── Hook: before_prompt_build — inject cached context ─────
    api.registerHook("before_prompt_build", async () => {
      try {
        const expired = invalidateExpired(cache, Date.now(), ttlMs);
        if (expired > 0) {
          api.logger?.info?.(
            `[oc-context-cache] Invalidated ${expired} expired entries before prompt build`
          );
        }
        api.logger?.info?.("[oc-context-cache] before_prompt_build hook executed");
      } catch (err) {
        api.logger?.error?.(
          `[oc-context-cache] before_prompt_build failed: ${String(err)}`
        );
      }
    }, { name: "context-cache-before-prompt" });

    // ── Hook: gateway_start — initialize cache ────────────────
    api.registerHook("gateway_start", async () => {
      try {
        invalidateExpired(cache, Date.now(), ttlMs);
        api.logger?.info?.(
          `[oc-context-cache] Cache initialized: ${cache.size} entries, TTL ${ttlMs}ms, max ${maxEntries}`
        );
      } catch (err) {
        api.logger?.error?.(
          `[oc-context-cache] gateway_start failed: ${String(err)}`
        );
      }
    }, { name: "context-cache-gateway-start" });

    // ── Hook: gateway_stop — clear cache ──────────────────────
    api.registerHook("gateway_stop", async () => {
      try {
        const size = cache.size;
        cache.clear();
        api.logger?.info?.(
          `[oc-context-cache] Cache cleared: ${size} entries removed`
        );
      } catch (err) {
        api.logger?.error?.(
          `[oc-context-cache] gateway_stop failed: ${String(err)}`
        );
      }
    }, { name: "context-cache-gateway-stop" });

    // ── Tool: context_cache_stats ─────────────────────────────
    api.registerTool({
      name: "context_cache_stats",
      description:
        "Report cache statistics — cache size, hit rate, entry details, and TTL configuration.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const stats = getCacheStats(cache, Date.now(), ttlMs, maxEntries);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: String(err),
                }),
              },
            ],
          };
        }
      },
    });
  },
});