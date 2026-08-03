/**
 * Result Cache & Deduplication — pure logic, no I/O, deterministic.
 *
 * @behavior
 * Provides a simple in-memory LRU-like cache with TTL expiry, hit tracking,
 * and result deduplication. All functions are pure (input → output, no side
 * effects). No {@link Date.now} or {@link Math.random} — timestamps are
 * injected.
 *
 * @invariants
 * - `putEntry` returns a new Map; does not mutate the input store.
 * - `invalidateExpired` returns a new Map; does not mutate the input store.
 * - All comparisons are deterministic (JSON.stringify for dedup, string
 *   matching for keys, numeric comparison for TTL).
 *
 * @dft
 * - Every function is testable without timers, I/O, or global state.
 * - Inline data, no fixtures.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface CacheEntry {
  key: string;
  result: unknown;
  createdAtMs: number;
  ttlMs: number;
  hitCount: number;
}

export type CacheStore = Map<string, CacheEntry>;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Simple deterministic string hash (djb2). Not cryptographic — suitable for
 * cache keys, not security.
 */
function djb2Hash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert signed 32-bit to unsigned hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Pure Functions ─────────────────────────────────────────────────────

/**
 * Produce a deterministic cache key from a query and task type.
 * Same query + same type => same key. Different query or type => different key.
 * Empty query is handled gracefully (still produces a key based on the type).
 */
export function cacheKey(query: string, taskType: string): string {
  return djb2Hash(`${query}::${taskType}`);
}

/**
 * Retrieve an entry from the cache store.
 *
 * Returns `{ hit: false }` when the key is absent or the entry is expired.
 * Returns `{ hit: true, entry }` when the key is present and not expired,
 * **but does not mutate the entry or store** — hitCount is returned as stored.
 * The caller (e.g. {@link getCachedResult}) should update the store separately
 * if it wishes to increment the hit count.
 *
 * The `expired` flag is independent of `hit`: when the key exists but is
 * expired, `{ hit: false, expired: true }` is returned.
 */
export function getEntry(
  store: CacheStore,
  key: string,
  nowMs: number,
): { hit: boolean; entry?: CacheEntry; expired: boolean } {
  const entry = store.get(key);
  if (entry === undefined) {
    return { hit: false, expired: false };
  }
  const expired = nowMs - entry.createdAtMs >= entry.ttlMs;
  return {
    hit: !expired,
    entry,
    expired,
  };
}

/**
 * Add a result to the cache. Returns a **new** Map (immutable — original is
 * not mutated). Overwrites any existing entry with the same key.
 */
export function putEntry(
  store: CacheStore,
  key: string,
  result: unknown,
  nowMs: number,
  ttlMs: number,
): CacheStore {
  const next = new Map(store);
  next.set(key, {
    key,
    result,
    createdAtMs: nowMs,
    ttlMs,
    hitCount: 0,
  });
  return next;
}

/**
 * Remove all expired entries from the cache. Returns a new Map and an array
 * of removed keys. Original store is not mutated.
 */
export function invalidateExpired(
  store: CacheStore,
  nowMs: number,
): { cleaned: CacheStore; removed: string[] } {
  const removed: string[] = [];
  const cleaned: CacheStore = new Map();
  for (const [key, entry] of store) {
    if (nowMs - entry.createdAtMs >= entry.ttlMs) {
      removed.push(key);
    } else {
      cleaned.set(key, entry);
    }
  }
  return { cleaned, removed };
}

/**
 * Compute the cache hit rate as hits / totalQueries.
 * Returns 0 when totalQueries is 0 (avoids division by zero).
 * Result is clamped to [0, 1].
 */
export function computeHitRate(
  store: CacheStore,
  totalQueries: number,
): number {
  if (totalQueries <= 0) return 0;
  let totalHits = 0;
  for (const entry of store.values()) {
    totalHits += entry.hitCount;
  }
  return Math.min(1, Math.max(0, totalHits / totalQueries));
}

/**
 * Merge two result arrays, removing duplicates based on JSON.stringify
 * comparison. Preserves order: cached results first, then new results that
 * are not already present. Returns a new array — does not mutate inputs.
 */
export function mergeAndDedup(
  cached: unknown[],
  newResults: unknown[],
): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];

  for (const item of cached) {
    const serialized = JSON.stringify(item);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      merged.push(item);
    }
  }

  for (const item of newResults) {
    const serialized = JSON.stringify(item);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      merged.push(item);
    }
  }

  return merged;
}

/**
 * Convenience wrapper: compute a cache key, look up the entry, and return
 * the result if it's a hit. Does NOT increment hitCount — the caller owns
 * that decision.
 */
export function getCachedResult(
  store: CacheStore,
  query: string,
  taskType: string,
  nowMs: number,
): { hit: boolean; result?: unknown } {
  const key = cacheKey(query, taskType);
  const result = getEntry(store, key, nowMs);
  if (result.hit && result.entry) {
    return { hit: true, result: result.entry.result };
  }
  return { hit: false };
}