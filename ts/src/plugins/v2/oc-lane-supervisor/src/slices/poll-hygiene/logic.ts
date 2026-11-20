/**
 * Poll Hygiene Pure Transition Algebra — zero-delta poll collapsing, turn poll budget,
 * and message-write frame suppression.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns explicit value contracts (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/poll-hygiene/tests/logic.spec.ts.
 */

import {
  compactZeroDeltaPollMessage,
  evaluateMessageWriteSuppression,
  evaluateTurnPollBudget,
} from "../../poll-hygiene-logic.js";
import type { PollHygieneSliceConfig, PollHygieneSliceState } from "./state.js";

export function processToolResultPoll(
  state: PollHygieneSliceState,
  config: PollHygieneSliceConfig,
  params: { sessionId: string; toolName: string; message: unknown; nowMs: number },
): {
  nextState: PollHygieneSliceState;
  message: unknown;
  isZeroDeltaPoll: boolean;
  budgetExceeded: boolean;
} {
  if (!config.enablePollDeduplication || !params.message || typeof params.message !== "object") {
    return { nextState: state, message: params.message, isZeroDeltaPoll: false, budgetExceeded: false };
  }

  const compactRes = compactZeroDeltaPollMessage(
    params.message as Record<string, unknown>,
    params.toolName,
  );
  let nextPollBudget = state.pollBudget;
  let budgetExceeded = false;

  if (compactRes.isZeroDelta && config.enableTurnPollBudget) {
    const budgetRes = evaluateTurnPollBudget(nextPollBudget, 1000, {
      turnPollBudgetMs: config.turnPollBudgetMs,
      enableTurnPollBudget: true,
    });
    nextPollBudget = budgetRes.nextState;
    budgetExceeded = !budgetRes.allowed;
  }

  return {
    nextState: { dedup: state.dedup, pollBudget: nextPollBudget },
    message: compactRes.message,
    isZeroDeltaPoll: compactRes.isZeroDelta,
    budgetExceeded,
  };
}

export function evaluatePollWriteSuppression(
  state: PollHygieneSliceState,
  config: PollHygieneSliceConfig,
  event: unknown,
): { nextState: PollHygieneSliceState; suppress: boolean } {
  if (!config.enablePollDeduplication || !event || typeof event !== "object") {
    return { nextState: state, suppress: false };
  }
  const res = evaluateMessageWriteSuppression(event as Record<string, unknown>, state.dedup);
  return { nextState: { ...state, dedup: res.nextState }, suppress: res.block };
}
