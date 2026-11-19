/**
 * Event Push Pure Transition Algebra — evaluates M1 tool-event note pushes and updates holds.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns immutable EventPushSliceState + push items.
 *
 * @dft
 * - Tested via slices/event-push/tests/logic.spec.ts.
 */

import {
  cleanExpiredSessionHolds,
  evaluateEventPush,
  type EventPushTriggerEvent,
  type PushedNoteItem,
} from "../../event-push-logic.js";
import type { NoteRegistry } from "../../memory-recall-logic.js";
import type { EventPushSliceState } from "./state.js";

export function stepEventPush(
  state: EventPushSliceState,
  registry: NoteRegistry,
  trigger: EventPushTriggerEvent,
  nowMs: number,
): {
  nextState: EventPushSliceState;
  notesToPush: PushedNoteItem[];
  telemetryEvents: Array<{ kind: string; arm: string }>;
} {
  const cleanedHolds = cleanExpiredSessionHolds(state.sessionHolds, nowMs, state.holdOnceTtlMs);
  const decision = evaluateEventPush(registry, trigger, cleanedHolds, nowMs, {
    defaultPolicy: "hold-once",
    holdOnceTtlMs: state.holdOnceTtlMs,
  });

  const telemetryEvents = decision.notesToPush.map((item) => ({
    kind: item.note.frontmatter.kind,
    arm: "M1",
  }));

  return {
    nextState: { ...state, sessionHolds: decision.newHoldState },
    notesToPush: decision.shouldPush ? decision.notesToPush : [],
    telemetryEvents,
  };
}
