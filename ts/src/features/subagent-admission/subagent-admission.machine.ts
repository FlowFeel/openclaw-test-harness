/**
 * Subagent lifecycle state machine — Pure Functional Transition Table.
 *
 * @behavior
 * Manages the complete lifecycle of a subagent session from creation
 * through archival. Every transition is explicit and typed — no
 * implicit state changes, no hidden paths.
 *
 * @invariants
 * - Terminal states (completed, failed, timed_out, aborted) can only
 *   transition to archived.
 * - Archived is fully terminal — no transitions out.
 * - The machine holds no I/O state; all persistence goes through
 *   the logic layer.
 *
 * @architecture
 * Upstream: spawn-admission logic (if admitted, dispatch event fires)
 * Downstream: session store (persisted via Effect logic layer)
 * Parallel: Python `lifecycle.py` — same states/events, different runtime
 */

import type { SubagentState, SubagentEvent } from "./subagent-admission.schema.js"

export const TRANSITIONS: Record<SubagentState, Partial<Record<SubagentEvent, SubagentState>>> = {
  created: {
    dispatch: "dispatched",
    parent_abort: "aborted",
  },
  dispatched: {
    start: "running",
    error: "failed",
    timeout: "timed_out",
    parent_abort: "aborted",
  },
  running: {
    yield: "yielding",
    finish: "completed",
    error: "failed",
    timeout: "timed_out",
    parent_abort: "aborted",
  },
  yielding: {
    child_done: "running",
    parent_abort: "aborted",
  },
  completed: {
    archive: "archived",
  },
  failed: {
    archive: "archived",
  },
  timed_out: {
    archive: "archived",
  },
  aborted: {
    archive: "archived",
  },
  archived: {},
}

/**
 * Pure transition function. Given a state and event, returns the next state.
 */
export function transitionSubagent(state: SubagentState, event: SubagentEvent): SubagentState {
  const next = TRANSITIONS[state][event]
  if (!next) {
    // If invalid transition from archived, it stays archived (archived is final)
    if (state === "archived") {
      return "archived"
    }
    // For test compatibility, return current state on invalid transition
    return state
  }
  return next
}

/**
 * A lightweight, zero-dependency actor-like wrapper to preserve compatibility
 * with tests that use xstate-like `createActor(machine)` APIs.
 */
export class SubagentActor {
  private currentState: SubagentState = "created"

  constructor(public readonly sessionKey: string) {}

  start() {
    this.currentState = "created"
    return this
  }

  send(event: { type: SubagentEvent }) {
    this.currentState = transitionSubagent(this.currentState, event.type)
  }

  getSnapshot() {
    return {
      value: this.currentState,
      context: {
        sessionKey: this.sessionKey,
        state: this.currentState,
      }
    }
  }
}

export const subagentMachine = {
  createActor: (input: { sessionKey: string }) => new SubagentActor(input.sessionKey)
}

// Emulate xstate's createActor function for imports in other files
export function createActor(machine: typeof subagentMachine, options: { input: { sessionKey: string } }) {
  return machine.createActor(options.input)
}
