/**
 * Turn Energy & Session Reputation State Slice.
 *
 * @invariants
 * - Owns per-session TurnEnergyState, SessionReputation, and turn timing maps.
 * - Zero coupling to poll-hygiene, forecaster, or topic-recovery slices.
 *
 * @dft
 * - Tested directly via slices/turn-energy/tests/logic.spec.ts.
 */

import type {
  TurnEnergyState,
  SessionReputation,
  SessionTier,
} from "../../../../../shared/efficiency-energy-logic.js";
import type { BridgeThrottleState } from "../../../../../shared/actionable-bridge-logic.js";

export interface TurnEnergySliceConfig {
  enabled: boolean;
  enableHeaders: boolean;
  initialSessionTier: SessionTier;
  suppressIdleHeartbeats: boolean;
}

export interface TurnEnergySliceState {
  readonly reputations: Map<string, SessionReputation>;
  readonly turnEnergy: Map<string, TurnEnergyState>;
  readonly bridgeThrottle: Map<string, BridgeThrottleState>;
  readonly turnStartTimes: Map<string, number>;
  readonly lastToolTimes: Map<string, number>;
}

export function createTurnEnergySliceState(): TurnEnergySliceState {
  return {
    reputations: new Map(),
    turnEnergy: new Map(),
    bridgeThrottle: new Map(),
    turnStartTimes: new Map(),
    lastToolTimes: new Map(),
  };
}

