/**
 * Poll Hygiene Slice Adapter — binds poll collapsing and message-write suppression.
 *
 * @invariants
 * - Owns only PollHygieneSliceState; zero direct I/O.
 *
 * @dft
 * - Tested via oc-lane-supervisor integration specs.
 */

import { createPollHygieneSliceState, type PollHygieneSliceConfig } from "./state.js";
import { processToolResultPoll, evaluatePollWriteSuppression } from "./logic.js";

export interface PollHygieneSliceHandle {
  onToolResultPersist: (params: {
    sessionId: string;
    toolName: string;
    message: unknown;
  }) => { message: unknown; isZeroDeltaPoll: boolean; budgetExceeded: boolean };
  onBeforeMessageWrite: (event: unknown) => { block: true } | unknown;
}

export function bindPollHygieneSlice(
  config: PollHygieneSliceConfig,
  clock: () => number = () => Date.now(),
): PollHygieneSliceHandle {
  let state = createPollHygieneSliceState();

  return {
    onToolResultPersist(params) {
      const res = processToolResultPoll(state, config, { ...params, nowMs: clock() });
      state = res.nextState;
      return {
        message: res.message,
        isZeroDeltaPoll: res.isZeroDeltaPoll,
        budgetExceeded: res.budgetExceeded,
      };
    },
    onBeforeMessageWrite(event: unknown) {
      const res = evaluatePollWriteSuppression(state, config, event);
      state = res.nextState;
      return res.suppress ? { block: true } : event;
    },
  };
}

