/**
 * Event Push State Slice — owns per-session hold-once delivery suppression state (M1).
 *
 * @invariants
 * - Isolated vertical slice state; receives NoteRegistry read-only at evaluation time.
 *
 * @dft
 * - Tested directly via slices/event-push/tests/logic.spec.ts.
 */

import {
  createInitialSessionHoldState,
  DEFAULT_HOLD_ONCE_TTL_MS,
  type SessionHoldState,
} from "../../event-push-logic.js";

export interface EventPushSliceState {
  readonly sessionHolds: SessionHoldState;
  readonly holdOnceTtlMs: number;
}

export function createEventPushSliceState(
  holdOnceTtlMs = DEFAULT_HOLD_ONCE_TTL_MS,
): EventPushSliceState {
  return {
    sessionHolds: createInitialSessionHoldState(),
    holdOnceTtlMs,
  };
}
