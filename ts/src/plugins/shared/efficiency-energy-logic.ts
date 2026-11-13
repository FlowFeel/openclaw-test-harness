/**
 * Pure logic for Plugin Efficiency Scoring, Habit Points & Energy Budgeting.
 *
 * Implements Foundry DFT Axioms (no side effects, deterministic pure functions)
 * and the Hypothetico-Axiomatic Empirical Feedback Calibration Loop.
 * @see team/specs/plugins-v2-efficiency-and-energy-spec.md
 */

export type SessionTier = "sovereign" | "standard" | "constrained";

export interface DynamicIncentiveRates {
  delegationRebate: number;
  delegationPoints: number;
  zeroDeltaPenaltyDrain: number;
  zeroDeltaPenaltyPoints: number;
  duplicateArgsPenaltyDrain: number;
  duplicateArgsPenaltyPoints: number;
  pollDrain: number;
  targetedReadPoints: number;
  cachedReadPoints: number;
  fastYieldPoints: number;
  parsimonyPoints: number;
}

export const DEFAULT_INCENTIVE_RATES: DynamicIncentiveRates = {
  delegationRebate: 200,
  delegationPoints: 150,
  zeroDeltaPenaltyDrain: 100,
  zeroDeltaPenaltyPoints: 120,
  duplicateArgsPenaltyDrain: 150,
  duplicateArgsPenaltyPoints: 150,
  pollDrain: 50,
  targetedReadPoints: 50,
  cachedReadPoints: 25,
  fastYieldPoints: 100,
  parsimonyPoints: 75,
};

export interface TurnEnergyConfig {
  initialEnergyByTier: Record<SessionTier, number>;
  idleDrainPerSecond: number;
  advisoryThreshold: number;
  exhaustionThreshold: number;
  rates: DynamicIncentiveRates;
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
  rates: DEFAULT_INCENTIVE_RATES,
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

export interface EmpiricalTurnMetrics {
  elapsedSeconds: number;
  actionsCount: number;
  delegationCount: number;
  zeroDeltaPollCount: number;
  transcriptInflationBytes: number;
  wasGated: boolean;
  approachedCriticalCeiling: boolean;
  finalTes: number;
}

export interface EmpiricalCalibrationProfile {
  p99YieldLatencySec: number;
  zeroDeltaBurstRate: number; // Ratio of zero-delta polls to total actions
  delegationOffloadRatio: number; // Ratio of delegations to complex turns (>4 actions)
  criticalCeilingHitRate: number; // Fraction of turns triggering advisory/gating
  meanTurnTes: number;
}

/**
 * Pure calibration function: feeds empirical metrics back into dynamic economic parameters.
 * Eliminates magic constants by adapting rates against observed behavior.
 */
export function calibrateEconomicParameters(
  baseline: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
  empirical: EmpiricalCalibrationProfile,
): TurnEnergyConfig {
  const updatedRates = { ...baseline.rates };

  // If agents are hitting critical ceiling or cutting close to supervisor aborts, raise advisory threshold
  let advisoryThreshold = baseline.advisoryThreshold;
  if (empirical.criticalCeilingHitRate > 0.25 || empirical.p99YieldLatencySec > 45) {
    advisoryThreshold = Math.min(400, baseline.advisoryThreshold + 50);
  } else if (empirical.criticalCeilingHitRate < 0.05 && empirical.p99YieldLatencySec < 15) {
    advisoryThreshold = Math.max(150, baseline.advisoryThreshold - 25);
  }

  // If delegation offload ratio is sluggish (<30% in complex tasks), strengthen the delegation rebate & points
  if (empirical.delegationOffloadRatio < 0.3) {
    updatedRates.delegationRebate = Math.min(350, updatedRates.delegationRebate + 50);
    updatedRates.delegationPoints = Math.min(250, updatedRates.delegationPoints + 25);
  } else if (empirical.delegationOffloadRatio > 0.7) {
    // Healthy equilibrium reached
    updatedRates.delegationRebate = Math.max(150, updatedRates.delegationRebate - 25);
  }

  // If zero-delta poll bursts persist, steepen penalty drain
  if (empirical.zeroDeltaBurstRate > 0.15) {
    updatedRates.zeroDeltaPenaltyDrain = Math.min(250, updatedRates.zeroDeltaPenaltyDrain + 50);
    updatedRates.zeroDeltaPenaltyPoints = Math.min(200, updatedRates.zeroDeltaPenaltyPoints + 30);
  }

  return {
    ...baseline,
    advisoryThreshold,
    rates: updatedRates,
  };
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

  const rates = config.rates ?? DEFAULT_INCENTIVE_RATES;
  const durationSec = Math.max(0, action.durationMs / 1000);
  let drain = durationSec * config.idleDrainPerSecond;
  let points = 0;
  let penalties = 0;
  let delegationCount = state.delegationCount;

  // Base action cost by category
  if (action.isDelegation) {
    // Rewarded offload
    drain -= rates.delegationRebate;
    points += rates.delegationPoints;
    delegationCount += 1;
  } else if (action.isZeroDelta) {
    // Zero-delta poll penalty
    drain += rates.zeroDeltaPenaltyDrain;
    penalties += rates.zeroDeltaPenaltyPoints;
  } else if (action.isDuplicateArgs) {
    // Circuit breaker trip
    drain += rates.duplicateArgsPenaltyDrain;
    penalties += rates.duplicateArgsPenaltyPoints;
  } else if (action.isPoll) {
    // In-lane poll
    drain += rates.pollDrain;
  } else if (action.isTargetedRead) {
    drain += 10;
    points += rates.targetedReadPoints;
  } else if (action.isCachedRead) {
    drain += 5;
    points += rates.cachedReadPoints;
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
export function evaluateTurnEfficiencyScore(
  state: TurnEnergyState,
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): number {
  const rates = config.rates ?? DEFAULT_INCENTIVE_RATES;
  // Bonus for fast yield if under 25s
  let finalPoints = state.habitPoints;
  if (state.elapsedSeconds > 0 && state.elapsedSeconds <= 25) {
    finalPoints += rates.fastYieldPoints;
  }

  // Parsimony bonus: answered with <= 4 tools
  if (state.actionsCount > 0 && state.actionsCount <= 4) {
    finalPoints += rates.parsimonyPoints;
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

export interface HabitTelemetryCardData {
  tier: SessionTier;
  rollingTes: number;
  lastTurnTes?: number;
  remainingEnergy: number;
  initialEnergy: number;
  habitPoints: number;
  penalties: number;
  actionsCount: number;
  delegationCount: number;
  maxSubagentSlots: number;
  queuePriority: string;
}

/**
 * Pure function to format a habit telemetry card for session_health or status displays.
 */
export function formatHabitTelemetryCard(data: HabitTelemetryCardData): string {
  const energyPct = Math.round((data.remainingEnergy / data.initialEnergy) * 100);
  const tierName = data.tier.toUpperCase();
  const offloadRatio =
    data.actionsCount > 0
      ? Math.round((data.delegationCount / data.actionsCount) * 100)
      : 0;

  return [
    `📊 Session Efficiency: Tier ${tierName === "SOVEREIGN" ? "3" : tierName === "STANDARD" ? "2" : "1"} (${tierName}) · Rolling TES ${data.rollingTes}/100`,
    `⚡ Energy Pool: ${Math.round(data.remainingEnergy)}/${data.initialEnergy} (${energyPct}%) | Max Subagents: ${data.maxSubagentSlots} | Priority: ${data.queuePriority}`,
    `🎯 Habits: +${data.habitPoints}P | Penalties: -${data.penalties}P | Offload Ratio: ${offloadRatio}% (${data.delegationCount}/${data.actionsCount} tools)`,
  ].join("\n");
}
