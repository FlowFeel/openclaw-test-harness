/**
 * Tool Hygiene Pure Transition Algebra — error circuit breaker, tool-result truncation,
 * and transient burst rollup transitions.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), immutable CheckResult transitions (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/tool-hygiene/tests/logic.spec.ts.
 */

import {
  applyToolResultTruncation,
  evaluatePreToolCallCircuitBreaker,
  recordToolCallOutcome,
} from "../../tool-result-hygiene-logic.js";
import {
  createTurnBurstTracker,
  recordToolResultForRollup,
  finalizeTurnRollup,
} from "../../rollup-logic.js";
import type { ToolHygieneSliceConfig, ToolHygieneSliceState } from "./state.js";

export function checkToolCircuitBreaker(
  state: ToolHygieneSliceState,
  config: ToolHygieneSliceConfig,
  toolName: string,
  params: unknown,
): { blocked: boolean; blockReason?: string } {
  const res = evaluatePreToolCallCircuitBreaker(
    state.breaker,
    toolName,
    params,
    config.circuitBreaker,
  );
  return { blocked: res.blocked, blockReason: res.error?.message };
}

export function applyToolResultHygiene(
  state: ToolHygieneSliceState,
  config: ToolHygieneSliceConfig,
  params: { sessionId: string; toolName: string; message: unknown },
): { nextState: ToolHygieneSliceState; message: unknown; truncated: boolean } {
  if (!params.message || typeof params.message !== "object") {
    return { nextState: state, message: params.message, truncated: false };
  }
  const msgObj = params.message as Record<string, unknown>;
  const trunc = applyToolResultTruncation(msgObj, params.toolName, config.truncation);
  const isError = Boolean(msgObj.isError);
  const nextBreaker = recordToolCallOutcome(state.breaker, params.toolName, undefined, {
    isError,
    errorMessage: isError ? String(msgObj.error ?? "tool error") : undefined,
  });

  if (config.rollupEnabled) {
    const tracker = state.rollupTrackers.get(params.sessionId) ?? createTurnBurstTracker();
    recordToolResultForRollup(tracker, params.toolName, config.rollup);
    state.rollupTrackers.set(params.sessionId, tracker);
  }

  return {
    nextState: { breaker: nextBreaker.state, rollupTrackers: state.rollupTrackers },
    message: trunc.message,
    truncated: trunc.changed,
  };
}

export function finalizeSessionRollup(
  state: ToolHygieneSliceState,
  config: ToolHygieneSliceConfig,
  sessionId: string,
): { squashedCount: number } {
  if (!config.rollupEnabled) return { squashedCount: 0 };
  const tracker = state.rollupTrackers.get(sessionId);
  if (!tracker) return { squashedCount: 0 };
  const summary = finalizeTurnRollup(tracker, config.rollup);
  state.rollupTrackers.delete(sessionId);
  return { squashedCount: summary.totalTransient };
}
