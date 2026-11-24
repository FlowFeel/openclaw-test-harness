/**
 * Turn Energy Pure Transition Algebra — idle-guard check, energy initialization,
 * soft-landing gating, pacing discount drain, and TES/EMA turn-end rollup.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns explicit CheckResult records (A1, A2, A6).
 *
 * @dft
 * - Tested directly via slices/turn-energy/tests/logic.spec.ts.
 */

import {
  initTurnEnergy,
  applyEnergyAction,
  evaluateTurnEfficiencyScore,
  updateSessionReputation,
  formatEnergyEnvelopeHeader,
  formatHabitTelemetryCard,
  DEFAULT_ENERGY_CONFIG,
  TARGETED_READ_TOOLS,
  POLL_TOOLS,
  type SessionReputation,
  type TurnEnergyState,
} from "../../../../../shared/efficiency-energy-logic.js";
import {
  createBridgeThrottleState,
  evaluateBridgeTrigger,
  renderActionableBridge,
} from "../../../../../shared/actionable-bridge-logic.js";
import { evaluateAgentRunAdmission } from "../../idle-guard-logic.js";
import type { TurnEnergySliceConfig, TurnEnergySliceState } from "./state.js";

export interface TurnStartAdmissionContext {
  trigger?: string;
  isHeartbeat?: boolean;
  isInteractiveChannel?: boolean;
}

export interface TurnStartResult {
  suppressed: boolean;
  reason?: string;
  energy?: TurnEnergyState;
}

export function startTurnEnergy(
  state: TurnEnergySliceState,
  config: TurnEnergySliceConfig,
  sessionId: string,
  prompt: string | undefined,
  nowMs: number,
  admissionCtx?: TurnStartAdmissionContext,
): TurnStartResult {
  const isHeartbeat =
    admissionCtx?.isHeartbeat === true || admissionCtx?.trigger === "heartbeat";
  const shouldCheckIdle =
    config.suppressIdleHeartbeats &&
    (!admissionCtx?.isInteractiveChannel || isHeartbeat) &&
    (prompt !== undefined || isHeartbeat);

  if (shouldCheckIdle) {
    const decision = evaluateAgentRunAdmission(prompt, {
      trigger: admissionCtx?.trigger,
      isHeartbeat: admissionCtx?.isHeartbeat,
    });
    if (decision.outcome === "block") {
      return { suppressed: true, reason: decision.reason };
    }
  }

  if (!config.enabled) return { suppressed: false };

  let rep: SessionReputation | undefined = state.reputations.get(sessionId);
  if (!rep) {
    rep = {
      tier: config.initialSessionTier,
      rollingTes: 1.0,
      maxSubagentSlots: 4,
      queuePriority: "normal",
    };
    state.reputations.set(sessionId, rep);
  }

  const energy = initTurnEnergy(rep.tier);
  state.turnEnergy.set(sessionId, energy);
  state.bridgeThrottle.set(sessionId, createBridgeThrottleState());
  state.turnStartTimes.set(sessionId, nowMs);
  state.lastToolTimes.set(sessionId, nowMs);
  return { suppressed: false, energy };
}

export function evaluateEnergyGate(
  _state: TurnEnergySliceState,
  _config: TurnEnergySliceConfig,
  _sessionId: string,
): { blocked: boolean; blockReason?: string } {
  // Pure OWA Non-Gating: tool execution is never blocked due to energy exhaustion
  return { blocked: false };
}

export function applyToolEnergyDrain(
  state: TurnEnergySliceState,
  config: TurnEnergySliceConfig,
  params: {
    sessionId: string;
    toolName: string;
    isZeroDeltaPoll: boolean;
    payloadBytes: number;
    nowMs: number;
  },
): { updated: boolean; remainingEnergy?: number; notice?: string } {
  if (!config.enabled) return { updated: false };
  const current = state.turnEnergy.get(params.sessionId);
  if (!current) return { updated: false };

  const lastTime = state.lastToolTimes.get(params.sessionId) ?? params.nowMs;
  const durationMs = Math.max(0, params.nowMs - lastTime);
  state.lastToolTimes.set(params.sessionId, params.nowMs);

  const next = applyEnergyAction(
    current,
    {
      toolName: params.toolName,
      durationMs,
      payloadBytes: params.payloadBytes,
      isPoll: params.isZeroDeltaPoll || POLL_TOOLS.has(params.toolName),
      isZeroDelta: params.isZeroDeltaPoll,
      isTargetedRead: TARGETED_READ_TOOLS.has(params.toolName),
    },
    DEFAULT_ENERGY_CONFIG,
  );
  state.turnEnergy.set(params.sessionId, next);

  const throttle = state.bridgeThrottle.get(params.sessionId) ?? createBridgeThrottleState();
  const bridge = evaluateBridgeTrigger(next, throttle);
  state.bridgeThrottle.set(params.sessionId, bridge.nextThrottle);

  const header = formatEnergyEnvelopeHeader(next);
  let notice: string | undefined;
  if (bridge.shouldEmit) {
    notice = renderActionableBridge(next, header);
  } else if (config.enableHeaders) {
    notice = `\n\n${header}`;
  }

  return { updated: true, remainingEnergy: next.remainingEnergy, notice };
}

export function finalizeTurnEnergy(
  state: TurnEnergySliceState,
  config: TurnEnergySliceConfig,
  sessionId: string,
  nowMs: number,
  producedVisibleReply: boolean,
): { updated: boolean; tes?: number; tier?: string } {
  if (!config.enabled) return { updated: false };
  const energy = state.turnEnergy.get(sessionId);
  const rep = state.reputations.get(sessionId);
  if (!energy || !rep) return { updated: false };

  const startMs = state.turnStartTimes.get(sessionId) ?? nowMs;
  const elapsedSeconds = Math.max(1, (nowMs - startMs) / 1000);
  const tes = evaluateTurnEfficiencyScore({ ...energy, elapsedSeconds }, DEFAULT_ENERGY_CONFIG);
  const adjustedTes = producedVisibleReply ? tes : Math.max(0, tes * 0.5);
  const nextRep = updateSessionReputation(rep, adjustedTes);
  state.reputations.set(sessionId, nextRep);
  return { updated: true, tes: adjustedTes, tier: nextRep.tier };
}

export function getSessionHealthCard(
  state: TurnEnergySliceState,
  sessionId: string,
): { reputation?: SessionReputation; efficiencyCard?: string } {
  const rep = state.reputations.get(sessionId);
  const energy = state.turnEnergy.get(sessionId);
  if (!rep) return {};
  return {
    reputation: rep,
    efficiencyCard: energy
      ? formatHabitTelemetryCard({
          tier: rep.tier,
          rollingTes: rep.rollingTes,
          remainingEnergy: energy.remainingEnergy,
          initialEnergy: energy.initialEnergy,
          habitPoints: energy.habitPoints,
          penalties: energy.penalties,
          actionsCount: energy.actionsCount,
          delegationCount: energy.delegationCount,
          maxSubagentSlots: rep.maxSubagentSlots,
          queuePriority: rep.queuePriority,
        })
      : undefined,
  };
}
