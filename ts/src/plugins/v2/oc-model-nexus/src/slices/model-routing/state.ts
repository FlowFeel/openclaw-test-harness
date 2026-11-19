/**
 * Model Routing State Slice — owns per-model latency/error statistics and call-ID dedup set.
 *
 * @invariants
 * - Isolated state slice; zero coupling to sibling slices.
 * - Pure data factory; injectable per plugin instance or shared across reloads.
 *
 * @dft
 * - Tested directly via slices/model-routing/tests/logic.spec.ts.
 */

export interface ModelStats {
  latencies: number[];
  errors: number;
  total: number;
  provider?: string;
  timeouts: number;
}

export type ModelStatsMap = Map<string, ModelStats>;

export interface ModelRoutingState {
  modelStats: ModelStatsMap;
  seenCallIds: Set<string>;
  reloadCount: number;
}

export interface ModelRouterConfig {
  p99ThresholdMs: number;
  errorRateThreshold: number;
  minSamples: number;
  maxSamples: number;
}

export const DEFAULT_MODEL_ROUTER_CONFIG: ModelRouterConfig = {
  p99ThresholdMs: 15000,
  errorRateThreshold: 0.1,
  minSamples: 5,
  maxSamples: 100,
};

export function createModelRoutingState(): ModelRoutingState {
  return {
    modelStats: new Map(),
    seenCallIds: new Set(),
    reloadCount: 0,
  };
}
