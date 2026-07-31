/**
 * Subagent lifecycle state machine — XState v5.
 *
 * @behavior
 * Manages the complete lifecycle of a subagent session from creation
 * through archival. Every transition is explicit and typed — no
 * implicit state changes, no hidden paths.
 *
 * @invariants
 * - Terminal states (completed, failed, timed_out, aborted) can only
 *   transition to archived. $\\forall s \\in \\text{Terminal}, \\text{transitions}(s, e) = \\{\\text{archive}\\}$.
 * - Archived is fully terminal — no transitions out.
 * - The machine holds no I/O state; all persistence goes through
 *   the logic layer via Effect.
 *
 * @remarks
 * XState v5 is used instead of a custom transition table because OC
 * itself may adopt XState for its own state management. Using the same
 * library means our test machine can be directly compared against
 * OC's actual session lifecycle behavior. The machine is tested in
 * isolation with `createActor` — no DOM, no browser, no I/O.
 *
 * @architecture
 * Upstream: spawn-admission logic (if admitted, dispatch event fires)
 * Downstream: session store (persisted via Effect logic layer)
 * Parallel: Python `lifecycle.py` — same states/events, different runtime
 */

import { setup } from "xstate"
import type { SubagentSnapshot, SubagentState, SubagentEvent } from "./subagent-admission.schema.js"

/**
 * @throws {StateError} If a transition is attempted from a terminal state
 *   with any event other than ARCHIVE.
 */
export const subagentMachine = setup({
  types: {
    context: {} as {
      sessionKey: string
      state: SubagentState
      startedAtMs: number | null
      endedAtMs: number | null
      retryCount: number
    },
    input: {} as {
      sessionKey: string
    },
    events: {} as
      | { type: "dispatch" }
      | { type: "start" }
      | { type: "yield" }
      | { type: "child_done" }
      | { type: "finish" }
      | { type: "error" }
      | { type: "timeout" }
      | { type: "parent_abort" }
      | { type: "archive" },
  },
}).createMachine({
  id: "subagent",
  initial: "created",
  context: ({ input }) => ({
    sessionKey: input.sessionKey,
    state: "created" as SubagentState,
    startedAtMs: null,
    endedAtMs: null,
    retryCount: 0,
  }),
  states: {
    created: {
      on: {
        dispatch: "dispatched",
        parent_abort: "aborted",
      },
    },
    dispatched: {
      on: {
        start: "running",
        error: "failed",
        timeout: "timed_out",
        parent_abort: "aborted",
      },
    },
    running: {
      on: {
        yield: "yielding",
        finish: "completed",
        error: "failed",
        timeout: "timed_out",
        parent_abort: "aborted",
      },
    },
    yielding: {
      on: {
        child_done: "running",
        parent_abort: "aborted",
      },
    },
    completed: {
      on: { archive: "archived" },
    },
    failed: {
      on: { archive: "archived" },
    },
    timed_out: {
      on: { archive: "archived" },
    },
    aborted: {
      on: { archive: "archived" },
    },
    archived: {
      type: "final",
    },
  },
})
