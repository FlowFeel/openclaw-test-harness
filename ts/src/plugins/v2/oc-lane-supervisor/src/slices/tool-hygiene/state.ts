/**
 * Tool Hygiene State Slice — owns identical-error circuit breaker and per-session burst rollup trackers.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to energy or admission slices.
 *
 * @dft
 * - Tested directly via slices/tool-hygiene/tests/logic.spec.ts.
 */

import {
  createInitialCircuitBreakerState,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type TruncationOptions,
} from "../../tool-result-hygiene-logic.js";
import type { TurnBurstTracker, RollupOptions } from "../../rollup-logic.js";

export interface ToolHygieneSliceConfig {
  truncation: TruncationOptions;
  circuitBreaker: CircuitBreakerConfig;
  rollupEnabled: boolean;
  rollup: RollupOptions;
}

export interface ToolHygieneSliceState {
  readonly breaker: CircuitBreakerState;
  readonly rollupTrackers: Map<string, TurnBurstTracker>;
}

export function createToolHygieneSliceState(): ToolHygieneSliceState {
  return {
    breaker: createInitialCircuitBreakerState(),
    rollupTrackers: new Map(),
  };
}

