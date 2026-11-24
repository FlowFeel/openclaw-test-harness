/**
 * Pure Actionable Bridge Logic — threshold evaluation, cadence throttling,
 * actionable guidance formatting, and non-destructive toolResult decoration.
 *
 * @invariants
 * - Pure deterministic logic: zero I/O, zero clocks, zero regexes (A1, A2, A6).
 * - Never mutates input state or input toolResult message objects.
 * - Uses TurnActionCounters queries (exceedsActionDensity, actionsSince) — zero raw math.
 *
 * @dft
 * - Tested directly via ts/tests/efficiency/actionable-bridge.spec.ts.
 */

import { actionsSince, exceedsActionDensity } from "./action-counter-logic.js";
import type { TurnEnergyState } from "./efficiency-energy-logic.js";

export interface ActionableBridgeConfig {
  readonly lowEnergyThreshold: number;
  readonly highDensityActions: number;
  readonly throttleIntervalActions: number;
}

export const DEFAULT_ACTIONABLE_BRIDGE_CONFIG: ActionableBridgeConfig = {
  lowEnergyThreshold: 200,
  highDensityActions: 12,
  throttleIntervalActions: 5,
};

export interface BridgeThrottleState {
  readonly lastEmittedAtAction: number | null;
}

export function createBridgeThrottleState(): BridgeThrottleState {
  return { lastEmittedAtAction: null };
}

export type BridgeEvaluationReason =
  | "low_energy"
  | "high_density"
  | "throttled"
  | "below_threshold";

export interface BridgeEvaluationResult {
  readonly shouldEmit: boolean;
  readonly reason: BridgeEvaluationReason;
  readonly nextThrottle: BridgeThrottleState;
}

/**
 * Pure CheckResult policy deciding whether to emit an actionable bridge
 * on the current tool result without nagging.
 */
export function evaluateBridgeTrigger(
  energy: TurnEnergyState,
  throttle: BridgeThrottleState,
  config: ActionableBridgeConfig = DEFAULT_ACTIONABLE_BRIDGE_CONFIG,
): BridgeEvaluationResult {
  const isLowEnergy = energy.remainingEnergy <= config.lowEnergyThreshold;
  const isHighDensity = exceedsActionDensity(energy.counters, config.highDensityActions);

  if (!isLowEnergy && !isHighDensity) {
    return {
      shouldEmit: false,
      reason: "below_threshold",
      nextThrottle: throttle,
    };
  }

  const elapsed = actionsSince(energy.counters, throttle.lastEmittedAtAction);
  if (elapsed !== null && elapsed < config.throttleIntervalActions) {
    return {
      shouldEmit: false,
      reason: "throttled",
      nextThrottle: throttle,
    };
  }

  return {
    shouldEmit: true,
    reason: isLowEnergy ? "low_energy" : "high_density",
    nextThrottle: { lastEmittedAtAction: energy.counters.totalActions },
  };
}

/**
 * Pure formatter for the actionable offload/batching bridge notice.
 */
export function renderActionableBridge(
  energy: TurnEnergyState,
  header: string,
): string {
  return (
    `\n\n${header}\n` +
    `⚡ Turn density high (${energy.counters.totalActions} actions). ` +
    `To avoid hitting lane timeout (600s), offload remaining inspection:\n` +
    `  → sessions_spawn(task="...", runtime="subagent") followed by sessions_yield()\n` +
    `  → Or batch atomic steps via exec_pipeline(steps=[...])`
  );
}

/**
 * Non-destructively appends a formatted notice to a toolResult message
 * (supporting both string content and structured content block arrays).
 */
export function appendNoticeToToolMessage(message: unknown, notice: string): unknown {
  if (!notice || !message || typeof message !== "object") {
    return message;
  }
  const msg = message as Record<string, unknown>;
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: [...msg.content, { type: "text", text: notice }],
    };
  }
  if (typeof msg.content === "string") {
    return {
      ...msg,
      content: msg.content + notice,
    };
  }
  return message;
}
