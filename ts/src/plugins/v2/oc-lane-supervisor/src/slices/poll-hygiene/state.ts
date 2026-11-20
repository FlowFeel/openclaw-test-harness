/**
 * Poll Hygiene State Slice — owns zero-delta poll deduplication and turn poll budget state.
 *
 * @invariants
 * - Isolated vertical slice state; communicates zero-delta classification via value contracts.
 *
 * @dft
 * - Tested directly via slices/poll-hygiene/tests/logic.spec.ts.
 */

import {
  createInitialPollDeduplicationState,
  createInitialTurnPollState,
  type PollDeduplicationState,
  type TurnPollState,
} from "../../poll-hygiene-logic.js";

export interface PollHygieneSliceConfig {
  enablePollDeduplication: boolean;
  enableTurnPollBudget: boolean;
  turnPollBudgetMs: number;
}

export interface PollHygieneSliceState {
  readonly dedup: PollDeduplicationState;
  readonly pollBudget: TurnPollState;
}

export function createPollHygieneSliceState(): PollHygieneSliceState {
  return {
    dedup: createInitialPollDeduplicationState(),
    pollBudget: createInitialTurnPollState(),
  };
}

