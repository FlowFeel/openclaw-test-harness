/**
 * Pure Energy Ledger & Reputation Algebra — per-turn energy accounting,
 * TES scoring, EMA session reputation, and habit telemetry formatting.
 *
 * @invariants
 * - Pure deterministic ledger: zero Node I/O, zero Date.now()/Math.random() (A1, A2).
 * - Delegates action counting to action-counter-logic.ts and rebate/friction policy
 *   to economic-policy-logic.ts (strict separation of concerns).
 * - Strict OWA Non-Gating: `isGated` is a diagnostic flag only, never freezing tool actions.
 *
 * @dft
 * - Tested via efficiency-energy.spec.ts, action-counter.spec.ts, economic-policy.spec.ts,
 *   plugins-v2-efficiency-energy.spec.ts, and hypothetico-axiomatic-calibration.spec.ts.
 * @see team/specs/plugins-v2-efficiency-and-energy-spec.md
 */

import {
  createTurnActionCounters,
  recordTurnAction,
  type TurnActionCounters,
} from "./action-counter-logic.js";
import {
  DEFAULT_INCENTIVE_RATES,
  classifyEconomicAction,
  evaluateEconomicAdjustment,
  type DynamicIncentiveRates,
  type EnergyActionSpec,
} from "./economic-policy-logic.js";

export {
  createTurnActionCounters,
  recordTurnAction,
  serialExecOverflow,
  exceedsActionDensity,
  actionsSince,
  type ActionEconomicKind,
  type TurnActionCounters,
} from "./action-counter-logic.js";

export {
  DELEGATION_TOOLS,
  PIPELINE_TOOLS,
  SERIAL_EXEC_TOOLS,
  TARGETED_READ_TOOLS,
  POLL_TOOLS,
  DEFAULT_INCENTIVE_RATES,
  isDelegationTool,
  isPipelineTool,
  isSerialExecTool,
  classifyEconomicAction,
  evaluateEconomicAdjustment,
  type DynamicIncentiveRates,
  type EnergyActionSpec,
  type EconomicAdjustment,
} from "./economic-policy-logic.js";

export type SessionTier = "sovereign" | "standard" | "constrained";

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
  counters: TurnActionCounters;
  /** Projected alias for `counters.totalActions` (backward compatibility). */
  actionsCount: number;
  /** Projected alias for `counters.delegationActions` (backward compatibility). */
  delegationCount: number;
  /** Projected alias for `counters.serialExecStreak` (backward compatibility). */
  serialExecCount: number;
  isGated: boolean;
  advisoryEmitted: boolean;
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
  zeroDeltaBurstRate: number;
  delegationOffloadRatio: number;
  criticalCeilingHitRate: number;
  meanTurnTes: number;
}

/**
 * Pure calibration function: feeds empirical metrics back into dynamic economic parameters.
 */
export function calibrateEconomicParameters(
  baseline: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
  empirical: EmpiricalCalibrationProfile,
): TurnEnergyConfig {
  const updatedRates = { ...baseline.rates };

  let advisoryThreshold = baseline.advisoryThreshold;
  if (empirical.criticalCeilingHitRate > 0.25 || empirical.p99YieldLatencySec > 45) {
    advisoryThreshold = Math.min(400, baseline.advisoryThreshold + 50);
  } else if (empirical.criticalCeilingHitRate < 0.05 && empirical.p99YieldLatencySec < 15) {
    advisoryThreshold = Math.max(150, baseline.advisoryThreshold - 25);
  }

  if (empirical.delegationOffloadRatio < 0.3) {
    updatedRates.delegationRebate = Math.min(350, updatedRates.delegationRebate + 50);
    updatedRates.delegationPoints = Math.min(250, updatedRates.delegationPoints + 25);
  } else if (empirical.delegationOffloadRatio > 0.7) {
    updatedRates.delegationRebate = Math.max(150, updatedRates.delegationRebate - 25);
  }

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

/** Initialize a turn energy state given the session tier. */
export function initTurnEnergy(
  tier: SessionTier = "standard",
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): TurnEnergyState {
  const initial = config.initialEnergyByTier[tier] ?? 1000;
  const counters = createTurnActionCounters();
  return {
    tier,
    initialEnergy: initial,
    remainingEnergy: initial,
    elapsedSeconds: 0,
    habitPoints: 0,
    penalties: 0,
    counters,
    actionsCount: counters.totalActions,
    delegationCount: counters.delegationActions,
    serialExecCount: counters.serialExecStreak,
    isGated: false,
    advisoryEmitted: false,
  };
}

/**
 * Pure Energy Ledger transition:
 *   1. Classify tool action via economic-policy-logic
 *   2. Advance TurnActionCounters via action-counter-logic
 *   3. Evaluate rebate/drain adjustment via economic-policy-logic
 *   4. Apply adjustment to energy ledger clamped to [0, initialEnergy]
 */
export function applyEnergyAction(
  state: TurnEnergyState,
  action: EnergyActionSpec,
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): TurnEnergyState {
  const rates = config.rates ?? DEFAULT_INCENTIVE_RATES;
  const durationSec = Math.max(0, action.durationMs / 1000);
  const currentCounters: TurnActionCounters = state.counters ?? {
    totalActions: state.actionsCount,
    delegationActions: state.delegationCount,
    pipelineActions: 0,
    serialExecStreak: state.serialExecCount ?? 0,
    zeroDeltaPolls: 0,
  };

  const kind = classifyEconomicAction(action);
  const nextCounters = recordTurnAction(currentCounters, kind);
  const adj = evaluateEconomicAdjustment(
    kind,
    action,
    nextCounters,
    config.idleDrainPerSecond,
    rates,
  );

  const newRemaining = Math.max(
    0,
    Math.min(state.initialEnergy, state.remainingEnergy + adj.energyDelta),
  );
  const isGated = newRemaining <= config.exhaustionThreshold;
  const advisoryEmitted = adj.clearsAdvisory
    ? false
    : state.advisoryEmitted || (newRemaining <= config.advisoryThreshold && !isGated);

  return {
    ...state,
    remainingEnergy: newRemaining,
    elapsedSeconds: state.elapsedSeconds + durationSec,
    habitPoints: state.habitPoints + adj.habitPointsDelta,
    penalties: state.penalties + adj.penaltiesDelta,
    counters: nextCounters,
    actionsCount: nextCounters.totalActions,
    delegationCount: nextCounters.delegationActions,
    serialExecCount: nextCounters.serialExecStreak,
    isGated,
    advisoryEmitted,
  };
}

/** Compute the Turn Efficiency Score (TES) in [0, 100]. */
export function evaluateTurnEfficiencyScore(
  state: TurnEnergyState,
  config: TurnEnergyConfig = DEFAULT_ENERGY_CONFIG,
): number {
  const rates = config.rates ?? DEFAULT_INCENTIVE_RATES;
  let finalPoints = state.habitPoints;
  if (state.elapsedSeconds > 0 && state.elapsedSeconds <= 25) {
    finalPoints += rates.fastYieldPoints;
  }
  if (state.actionsCount > 0 && state.actionsCount <= 4) {
    finalPoints += rates.parsimonyPoints;
  }
  const netScore = 50 + (finalPoints - state.penalties) / 10;
  return Math.max(0, Math.min(100, Math.round(netScore)));
}

/** Resolve session tier and resource allowances based on rolling TES. */
export function resolveTierFromTes(rollingTes: number): SessionTier {
  if (rollingTes >= 80) return "sovereign";
  if (rollingTes >= 50) return "standard";
  return "constrained";
}

/** Update rolling session reputation via EMA (alpha = 0.25). */
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

/** Format lightweight envelope feedback for tool_result_persist or inspection. */
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

/** Pure function to format a habit telemetry card for session_health or status displays. */
export function formatHabitTelemetryCard(data: HabitTelemetryCardData): string {
  const energyPct = Math.round((data.remainingEnergy / data.initialEnergy) * 100);
  const tierName = data.tier.toUpperCase();
  const offloadRatio =
    data.actionsCount > 0 ? Math.round((data.delegationCount / data.actionsCount) * 100) : 0;

  return [
    `📊 Session Efficiency: Tier ${tierName === "SOVEREIGN" ? "3" : tierName === "STANDARD" ? "2" : "1"} (${tierName}) · Rolling TES ${data.rollingTes}/100`,
    `⚡ Energy Pool: ${Math.round(data.remainingEnergy)}/${data.initialEnergy} (${energyPct}%) | Max Subagents: ${data.maxSubagentSlots} | Priority: ${data.queuePriority}`,
    `🎯 Habits: +${data.habitPoints}P | Penalties: -${data.penalties}P | Offload Ratio: ${offloadRatio}% (${data.delegationCount}/${data.actionsCount} tools)`,
  ].join("\n");
}
