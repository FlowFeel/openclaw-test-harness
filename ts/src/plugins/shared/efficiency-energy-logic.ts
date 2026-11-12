/**
 * Pure logic for Plugin Efficiency Scoring, Habit Points & Energy Budgeting.
 *
 * Implements Foundry DFT Axioms (no side effects, deterministic pure functions).
 * @see team/specs/plugins-v2-efficiency-and-energy-spec.md
 */

export type SessionTier = "sovereign" | "standard" | "constrained";

export interface TurnEnergyConfig {
  initialEnergyByTier: Record<SessionTier, number>;
  idleDrainPerSecond: number;
  advisoryThreshold: number;
  exhaustionThreshold: number;
}

export const DEFAULT_ENERGY_CONFIG: TurnEnergyConfig = {
  initialEnergyByTier: {
    sovereign: 1200,
    standard: 1000,
    constrained: 600,
  },
  idleDrainPerSecond: 1.0,
  advisoryThreshold: 200,
  exhaustionThreshold: 0,
};

export interface TurnEnergyState {
  tier: SessionTier;
  initialEnergy: number;
  remainingEnergy: number;
  elapsedSeconds: number;
  habitPoints: number;
  penalties: number;
  actionsCount: number;
  delegationCount: number;
  isGated: boolean;
  advisoryEmitted: boolean;
}

export interface EnergyActionSpec {
  toolName: string;
  durationMs: number;
  payloadBytes?: number;
  isPoll?: boolean;
  isZeroDelta?: boolean;
  isDuplicateArgs?: boolean;
  isDelegation?: boolean;
  isCachedRead?: boolean;
  isTargetedRead?: boolean;
}

export interface SessionReputation {
  rollingTes: number;
  tier: SessionTier;
  maxSubagentSlots: number;
  queuePriority: "high" | "normal" | "low";
}

/**
 * Initialize a turn energy state given the session tier.
 */
export function initTurnEnergy(
  tier: SessionTier = "standard",
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): TurnEnergyState {
  const initial = config.initialEnergyByTier[tier] ?? 1000;
  return {
    tier,
    initialEnergy: initial,
    remainingEnergy: initial,
    elapsedSeconds: 0,
    habitPoints: 0,
    penalties: 0,
    actionsCount: 0,
    delegationCount: 0,
    isGated: false,
    advisoryEmitted: false,
  };
}

/**
 * Evaluate energy deduction and point adjustments for a discrete tool action.
 */
export function applyEnergyAction(
  state: TurnEnergyState,
  action: EnergyActionSpec,
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): TurnEnergyState {
  if (state.isGated) {
    return state;
  }

  const durationSec = Math.max(0, action.durationMs / 1000);
  let drain = durationSec * config.idleDrainPerSecond;
  let points = 0;
  let penalties = 0;
  let delegationCount = state.delegationCount;

  // Base action cost by category
  if (action.isDelegation) {
    // Rewarded offload
    drain -= 200; // energy rebate
    points += 150;
    delegationCount += 1;
  } else if (action.isZeroDelta) {
    // Zero-delta poll penalty
    drain += 100;
    penalties += 120;
  } else if (action.isDuplicateArgs) {
    // Circuit breaker trip
    drain += 150;
    penalties += 150;
  } else if (action.isPoll) {
    // In-lane poll
    drain += 50;
  } else if (action.isTargetedRead) {
    drain += 10;
    points += 50;
  } else if (action.isCachedRead) {
    drain += 5;
    points += 25;
  } else {
    // Normal tool call
    drain += 15;
  }

  // Heavy synchronous execution penalty
  if (durationSec > 30 && !action.isDelegation) {
    drain += 30 + durationSec * 2.0;
  }

  // Payload bloat penalty (>20KB)
  if (action.payloadBytes && action.payloadBytes > 20480) {
    drain += 100;
    penalties += 50;
  }

  const newElapsed = state.elapsedSeconds + durationSec;
  const newRemaining = Math.max(0, state.remainingEnergy - drain);
  const isGated = newRemaining <= config.exhaustionThreshold;
  const advisoryEmitted =
    state.advisoryEmitted || (newRemaining <= config.advisoryThreshold && !isGated);

  return {
    ...state,
    remainingEnergy: newRemaining,
    elapsedSeconds: newElapsed,
    habitPoints: state.habitPoints + points,
    penalties: state.penalties + penalties,
    actionsCount: state.actionsCount + 1,
    delegationCount,
    isGated,
    advisoryEmitted,
  };
}

/**
 * Compute the Turn Efficiency Score (TES) in [0, 100].
 */
export function evaluateTurnEfficiencyScore(state: TurnEnergyState): number {
  // Bonus for fast yield if under 25s
  let finalPoints = state.habitPoints;
  if (state.elapsedSeconds > 0 && state.elapsedSeconds <= 25) {
    finalPoints += 100;
  }

  // Parsimony bonus: answered with <= 4 tools
  if (state.actionsCount > 0 && state.actionsCount <= 4) {
    finalPoints += 75;
  }

  const netScore = 50 + (finalPoints - state.penalties) / 10;
  return Math.max(0, Math.min(100, Math.round(netScore)));
}

/**
 * Resolve session tier and resource allowances based on rolling TES.
 */
export function resolveTierFromTes(rollingTes: number): SessionTier {
  if (rollingTes >= 80) return "sovereign";
  if (rollingTes >= 50) return "standard";
  return "constrained";
}

/**
 * Update rolling session reputation via EMA (alpha = 0.25).
 */
export function updateSessionReputation(
  current: SessionReputation,
  turnTes: number,
  alpha = 0.25,
): SessionReputation {
  const newRolling = Math.round(alpha * turnTes + (1 - alpha) * current.rollingTes);
  const newTier = resolveTierFromTes(newRolling);

  let maxSubagentSlots = 3;
  let queuePriority: "high" | "normal" | "low" = "normal";

  if (newTier === "sovereign") {
    maxSubagentSlots = 6;
    queuePriority = "high";
  } else if (newTier === "constrained") {
    maxSubagentSlots = 1;
    queuePriority = "low";
  }

  return {
    rollingTes: newRolling,
    tier: newTier,
    maxSubagentSlots,
    queuePriority,
  };
}

/**
 * Format lightweight envelope feedback for tool_result_persist or inspection.
 */
export function formatEnergyEnvelopeHeader(state: TurnEnergyState): string {
  const remainingPercent = Math.round((state.remainingEnergy / state.initialEnergy) * 100);
  return `[⚡ Energy: ${Math.round(state.remainingEnergy)}/${state.initialEnergy} (${remainingPercent}%) | Tier: ${state.tier.toUpperCase()} | Habits: +${state.habitPoints}P]`;
}
