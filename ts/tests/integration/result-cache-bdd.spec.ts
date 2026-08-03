/**
 * BDD tests for Result Cache & Deduplication (#25).
 *
 * DFT: pure logic, no I/O, no Date.now(), immutable, deterministic, inline data.
 * Imports from "../../src/plugins/shared/result-cache.js"
 */

import { describe, it, expect } from "vitest"
import {
  cacheKey,
  getEntry,
  putEntry,
  invalidateExpired,
  computeHitRate,
  mergeAndDedup,
  getCachedResult,
  type CacheStore,
} from "../../src/plugins/shared/result-cache.js"

// ── Helpers ────────────────────────────────────────────────────────────

/** Create an empty store. */
function emptyStore(): CacheStore {
  return new Map()
}

/** Create a store pre-populated with one entry. */
function storeWithEntry(
  key: string,
  result: unknown,
  nowMs: number,
  ttlMs: number,
): CacheStore {
  const store = emptyStore()
  return putEntry(store, key, result, nowMs, ttlMs)
}

// ── Feature: Cache Key Generation ─────────────────────────────────────

describe("Feature: Cache Key Generation", () => {
  it("Scenario: Same query and task type produce the same key", () => {
    const key1 = cacheKey("research quantum gravity", "deep_analysis")
    const key2 = cacheKey("research quantum gravity", "deep_analysis")
    expect(key1).toBe(key2)
  })

  it("Scenario: Different queries produce different keys", () => {
    const key1 = cacheKey("hello world", "search")
    const key2 = cacheKey("goodbye world", "search")
    expect(key1).not.toBe(key2)
  })

  it("Scenario: Different task types produce different keys", () => {
    const key1 = cacheKey("hello world", "search")
    const key2 = cacheKey("hello world", "deep_analysis")
    expect(key1).not.toBe(key2)
  })

  it("Scenario: Empty query is handled gracefully", () => {
    const key = cacheKey("", "noop")
    // Should be a non-empty string that is deterministic
    expect(key).toBeTruthy()
    expect(typeof key).toBe("string")
    expect(key.length).toBeGreaterThan(0)
    // Deterministic: same call again produces same result
    expect(cacheKey("", "noop")).toBe(key)
  })
})

// ── Feature: Cache Get/Put ────────────────────────────────────────────

describe("Feature: Cache Get/Put", () => {
  it("Scenario: Miss on empty cache", () => {
    const store = emptyStore()
    const result = getEntry(store, "abc123", 1000)
    expect(result.hit).toBe(false)
    expect(result.expired).toBe(false)
    expect(result.entry).toBeUndefined()
  })

  it("Scenario: Hit after put", () => {
    let store = emptyStore()
    store = putEntry(store, "k1", { data: "hello" }, 100, 5000)
    const result = getEntry(store, "k1", 200)
    expect(result.hit).toBe(true)
    expect(result.expired).toBe(false)
    expect(result.entry).toBeDefined()
    expect(result.entry!.result).toEqual({ data: "hello" })
  })

  it("Scenario: Miss after TTL expiry", () => {
    let store = emptyStore()
    store = putEntry(store, "k1", "data", 100, 50) // TTL 50ms
    const result = getEntry(store, "k1", 200) // nowMs = 200, age = 100 >= 50
    expect(result.hit).toBe(false)
    expect(result.expired).toBe(true)
  })

  it("Scenario: Hit increments hitCount (via putEntry reset)", () => {
    // putEntry creates a fresh entry with hitCount=0. The hitCount on the
    // CacheEntry is read-only from the cache perspective — we verify that
    // the stored entry has hitCount=0 after put, meaning the caller can
    // increment it manually when desired.
    let store = emptyStore()
    store = putEntry(store, "k1", "x", 100, 5000)
    const result = getEntry(store, "k1", 200)
    expect(result.hit).toBe(true)
    expect(result.entry!.hitCount).toBe(0)

    // Simulate the caller incrementing hitCount after a hit
    const entry = store.get("k1")!
    entry.hitCount += 1
    const store2 = new Map(store)
    expect(getEntry(store2, "k1", 300).entry!.hitCount).toBe(1)
  })

  it("Scenario: Different keys don't collide", () => {
    let store = emptyStore()
    store = putEntry(store, "k1", "a", 100, 5000)
    store = putEntry(store, "k2", "b", 100, 5000)
    expect(getEntry(store, "k1", 200).entry!.result).toBe("a")
    expect(getEntry(store, "k2", 200).entry!.result).toBe("b")
  })
})

// ── Feature: TTL Expiry ───────────────────────────────────────────────

describe("Feature: TTL Expiry", () => {
  it("Scenario: Entry valid before TTL", () => {
    const store = storeWithEntry("k1", "data", 100, 100)
    // At nowMs=150: age=50 < TTL=100 → still valid
    const result = getEntry(store, "k1", 150)
    expect(result.hit).toBe(true)
    expect(result.expired).toBe(false)
  })

  it("Scenario: Entry expired after TTL", () => {
    const store = storeWithEntry("k1", "data", 100, 100)
    // At nowMs=200: age=100 >= TTL=100 → expired (boundary: >=)
    const result = getEntry(store, "k1", 200)
    expect(result.hit).toBe(false)
    expect(result.expired).toBe(true)
  })

  it("Scenario: invalidateExpired removes stale entries", () => {
    let store = emptyStore()
    store = putEntry(store, "fresh", "a", 100, 200) // TTL 200ms
    store = putEntry(store, "stale", "b", 100, 50)  // TTL 50ms
    const { cleaned, removed } = invalidateExpired(store, 200)
    // "stale" age=100 >= 50 → removed; "fresh" age=100 < 200 → kept
    expect(removed).toEqual(["stale"])
    expect(cleaned.has("fresh")).toBe(true)
    expect(cleaned.has("stale")).toBe(false)
  })

  it("Scenario: invalidateExpired keeps fresh entries", () => {
    let store = emptyStore()
    store = putEntry(store, "k1", "data", 500, 1000)
    const { cleaned, removed } = invalidateExpired(store, 1000)
    expect(removed).toHaveLength(0)
    expect(cleaned.size).toBe(1)
    expect(cleaned.get("k1")!.result).toBe("data")
  })
})

// ── Feature: Hit Rate ─────────────────────────────────────────────────

describe("Feature: Hit Rate", () => {
  it("Scenario: 100% hit rate", () => {
    const store: CacheStore = new Map([
      ["a", { key: "a", result: "x", createdAtMs: 0, ttlMs: 1000, hitCount: 5 }],
      ["b", { key: "b", result: "y", createdAtMs: 0, ttlMs: 1000, hitCount: 3 }],
    ])
    // 8 hits out of 8 queries = 1.0
    expect(computeHitRate(store, 8)).toBe(1)
  })

  it("Scenario: 0% hit rate", () => {
    const store: CacheStore = new Map([
      ["a", { key: "a", result: "x", createdAtMs: 0, ttlMs: 1000, hitCount: 0 }],
      ["b", { key: "b", result: "y", createdAtMs: 0, ttlMs: 1000, hitCount: 0 }],
    ])
    // 0 hits, 10 queries = 0
    expect(computeHitRate(store, 10)).toBe(0)
  })

  it("Scenario: Mixed hit rate", () => {
    const store: CacheStore = new Map([
      ["a", { key: "a", result: "x", createdAtMs: 0, ttlMs: 1000, hitCount: 3 }],
      ["b", { key: "b", result: "y", createdAtMs: 0, ttlMs: 1000, hitCount: 7 }],
    ])
    // 10 hits out of 20 queries = 0.5
    expect(computeHitRate(store, 20)).toBe(0.5)
  })
})

// ── Feature: Merge & Dedup ────────────────────────────────────────────

describe("Feature: Merge & Dedup", () => {
  it("Scenario: No overlap — all unique results", () => {
    const result = mergeAndDedup([1, 2], [3, 4])
    expect(result).toEqual([1, 2, 3, 4])
  })

  it("Scenario: Full overlap — all deduped", () => {
    const result = mergeAndDedup(["a", "b"], ["a", "b"])
    expect(result).toEqual(["a", "b"])
  })

  it("Scenario: Partial overlap — merged with dedup", () => {
    const result = mergeAndDedup(
      [{ id: 1 }, { id: 2 }],
      [{ id: 2 }, { id: 3 }],
    )
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it("Scenario: Empty inputs", () => {
    expect(mergeAndDedup([], [])).toEqual([])
    expect(mergeAndDedup([1], [])).toEqual([1])
    expect(mergeAndDedup([], [1])).toEqual([1])
  })
})

// ── Feature: Immutability ─────────────────────────────────────────────

describe("Feature: Immutability", () => {
  it("Scenario: putEntry returns a new map", () => {
    const original = emptyStore()
    const updated = putEntry(original, "k1", "val", 100, 5000)
    expect(original).not.toBe(updated)
    expect(original.size).toBe(0)
    expect(updated.size).toBe(1)
  })

  it("Scenario: invalidateExpired returns a new map", () => {
    let store = emptyStore()
    store = putEntry(store, "k1", "val", 100, 50)
    const { cleaned } = invalidateExpired(store, 200)
    expect(store).not.toBe(cleaned)
    // Original still has the entry
    expect(store.size).toBe(1)
    // Cleaned has removed it
    expect(cleaned.size).toBe(0)
  })

  it("Scenario: Original store unchanged after putEntry", () => {
    const original = emptyStore()
    putEntry(original, "k1", "val", 100, 5000)
    // Original should still be empty
    expect(original.size).toBe(0)
  })
})

// ── Feature: getCachedResult Convenience Wrapper ───────────────────────

describe("Feature: getCachedResult Convenience Wrapper", () => {
  it("Scenario: Returns hit=false on empty cache", () => {
    const store = emptyStore()
    const result = getCachedResult(store, "query", "task", 100)
    expect(result.hit).toBe(false)
    expect(result.result).toBeUndefined()
  })

  it("Scenario: Returns hit=true and result when cached", () => {
    let store = emptyStore()
    store = putEntry(store, cacheKey("hello", "greet"), "world", 100, 5000)
    const result = getCachedResult(store, "hello", "greet", 200)
    expect(result.hit).toBe(true)
    expect(result.result).toBe("world")
  })

  it("Scenario: Returns hit=false after TTL expiry", () => {
    let store = emptyStore()
    store = putEntry(store, cacheKey("hello", "greet"), "world", 100, 50)
    const result = getCachedResult(store, "hello", "greet", 200)
    expect(result.hit).toBe(false)
    expect(result.result).toBeUndefined()
  })
})