/**
 * Context Cache Observability State Slice — passive, read-only provider cache telemetry.
 *
 * @invariants
 * - Strictly non-interfering: observes provider-reported cache hits/misses without modifying
 *   prompts, bloating token count, or interfering with upstream provider caching.
 *
 * @dft
 * - Tested directly via slices/context-cache/tests/logic.spec.ts.
 */

export interface CacheEntry {
  value: unknown;
  createdAtMs: number;
  hitCount: number;
}

export type CacheStore = Map<string, CacheEntry>;

export interface ProviderCacheTelemetry {
  readonly observedCalls: number;
  readonly providerCacheHits: number;
  readonly providerCacheReadTokens: number;
  readonly providerCacheWriteTokens: number;
}

export interface ContextCacheSliceState {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly store: CacheStore;
  readonly providerTelemetry: ProviderCacheTelemetry;
}

export function createContextCacheState(
  ttlMs = 300000,
  maxEntries = 100,
): ContextCacheSliceState {
  return {
    ttlMs,
    maxEntries,
    store: new Map(),
    providerTelemetry: {
      observedCalls: 0,
      providerCacheHits: 0,
      providerCacheReadTokens: 0,
      providerCacheWriteTokens: 0,
    },
  };
}

