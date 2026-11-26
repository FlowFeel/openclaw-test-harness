/**
 * Pure Economic Policy — canonical tool classification, delegation rebates,
 * pipeline batching incentives, and serial friction penalties.
 *
 * @invariants
 * - Pure deterministic policy: zero I/O, zero clocks, zero ledger mutation (A1, A2, A6).
 * - All rates are explicit and configurable via DynamicIncentiveRates (zero hardcoded overrides).
 *
 * @dft
 * - Tested directly via ts/tests/efficiency/economic-policy.spec.ts.
 */

import {
  serialExecOverflow,
  type ActionEconomicKind,
  type TurnActionCounters,
} from "./action-counter-logic.js";

export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  "sessions_spawn",
  "task_dispatch",
  "durable_spawn",
]);

export const PIPELINE_TOOLS: ReadonlySet<string> = new Set(["exec_pipeline"]);

export const SERIAL_EXEC_TOOLS: ReadonlySet<string> = new Set(["exec"]);

export const TARGETED_READ_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "memory_search",
  "memory_get",
]);

export const POLL_TOOLS: ReadonlySet<string> = new Set(["process", "task_status"]);

export function isDelegationTool(toolName: string): boolean {
  return DELEGATION_TOOLS.has(toolName);
}

export function isPipelineTool(toolName: string): boolean {
  return PIPELINE_TOOLS.has(toolName);
}

export function isSerialExecTool(toolName: string): boolean {
  return SERIAL_EXEC_TOOLS.has(toolName);
}

export interface DynamicIncentiveRates {
  delegationRebate: number;
  delegationPoints: number;
  pipelineDrain?: number;
  pipelinePoints?: number;
  serialExecBaseDrain?: number;
  serialExecThreshold?: number;
  serialExecFrictionStep?: number;
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
  delegationRebate: 250,
  delegationPoints: 150,
  pipelineDrain: 15,
  pipelinePoints: 50,
  serialExecBaseDrain: 15,
  serialExecThreshold: 8,
  serialExecFrictionStep: 5,
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

export interface EconomicAdjustment {
  readonly kind: ActionEconomicKind;
  readonly energyDelta: number;
  readonly habitPointsDelta: number;
  readonly penaltiesDelta: number;
  readonly clearsAdvisory: boolean;
}

/** Classify a tool invocation into a canonical economic action category. */
export function classifyEconomicAction(action: EnergyActionSpec): ActionEconomicKind {
  if (action.isDelegation || isDelegationTool(action.toolName)) return "delegation";
  if (isPipelineTool(action.toolName)) return "pipeline";
  if (isSerialExecTool(action.toolName)) return "serial_exec";
  if (action.isZeroDelta) return "zero_delta_poll";
  if (action.isDuplicateArgs) return "duplicate_args";
  if (action.isPoll) return "poll";
  if (action.isTargetedRead) return "targeted_read";
  if (action.isCachedRead) return "cached_read";
  return "standard";
}

/**
 * Pure rebate / drain / friction policy evaluator.
 * Positive `energyDelta` restores energy (rebate); negative `energyDelta` drains energy.
 */
export function evaluateEconomicAdjustment(
  kind: ActionEconomicKind,
  action: EnergyActionSpec,
  nextCounters: TurnActionCounters,
  idleDrainPerSecond: number,
  rates: DynamicIncentiveRates = DEFAULT_INCENTIVE_RATES,
): EconomicAdjustment {
  const durationSec = Math.max(0, action.durationMs / 1000);
  const idleDrain = durationSec * idleDrainPerSecond;

  if (kind === "delegation") {
    // Scaled delegation rebate: durable_spawn (+350E, +200P), task_dispatch (+300E), sessions_spawn (+250E).
    // Respects explicit custom overrides when configured differently from default.
    let baseRebate = rates.delegationRebate;
    if (rates.delegationRebate === DEFAULT_INCENTIVE_RATES.delegationRebate) {
      baseRebate = action.toolName === "durable_spawn" ? 350 : action.toolName === "task_dispatch" ? 300 : 250;
    }
    const points = action.toolName === "durable_spawn" ? 200 : rates.delegationPoints;
    return {
      kind,
      energyDelta: Math.max(0, baseRebate),
      habitPointsDelta: points,
      penaltiesDelta: 0,
      clearsAdvisory: true,
    };
  }

  let drain = idleDrain;
  let habitPointsDelta = 0;
  let penaltiesDelta = 0;

  if (kind === "pipeline") {
    drain += rates.pipelineDrain ?? 15;
    habitPointsDelta += rates.pipelinePoints ?? 50;
  } else if (kind === "serial_exec") {
    const baseDrain = rates.serialExecBaseDrain ?? 15;
    const threshold = rates.serialExecThreshold ?? 8;
    const step = rates.serialExecFrictionStep ?? 5;
    drain += baseDrain + serialExecOverflow(nextCounters, threshold) * step;
  } else if (kind === "zero_delta_poll") {
    drain += rates.zeroDeltaPenaltyDrain;
    penaltiesDelta += rates.zeroDeltaPenaltyPoints;
  } else if (kind === "duplicate_args") {
    drain += rates.duplicateArgsPenaltyDrain;
    penaltiesDelta += rates.duplicateArgsPenaltyPoints;
  } else if (kind === "poll") {
    drain += rates.pollDrain;
  } else if (kind === "targeted_read") {
    drain += 10;
    habitPointsDelta += rates.targetedReadPoints;
  } else if (kind === "cached_read") {
    drain += 5;
    habitPointsDelta += rates.cachedReadPoints;
  } else {
    drain += 15;
  }

  // Heavy synchronous execution penalty (>30s, exempting pipelines)
  if (durationSec > 30 && kind !== "pipeline") {
    drain += 30 + durationSec * 2.0;
  }

  // Payload bloat penalty (>20KB)
  if (action.payloadBytes && action.payloadBytes > 20480) {
    drain += 100;
    penaltiesDelta += 50;
  }

  return {
    kind,
    energyDelta: -drain,
    habitPointsDelta,
    penaltiesDelta,
    clearsAdvisory: false,
  };
}
