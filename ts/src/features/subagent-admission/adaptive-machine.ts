/**
 * XState v5 machine for adaptive subagent lifecycle with self-reporting.
 *
 * @behavior
 * Replaces the static lifecycle with an adaptive one:
 * - Subagents self-report status on a cadence
 * - Missing reports trigger a "yielding" state (not kill)
 * - The system adapts spawn limits based on health metrics
 * - Stale subagents can checkpoint and exit gracefully
 *
 * @invariants
 * - A stale subagent enters "yielding" (not "timed_out" + kill)
 * - A yielding subagent can checkpoint and transition to "done"
 * - The machine tracks progress (0.0 to 1.0) and estimated time
 */

import { setup, assign } from "xstate"

export const adaptiveSubagentMachine = setup({
  types: {
    context: {} as {
      sessionKey: string
      progress: number
      lastReportAtMs: number
      estimatedRemainingMs: number | null
      staleCount: number
    },
    input: {} as {
      sessionKey: string
    },
    events: {} as
      | { type: "dispatch" }
      | { type: "start" }
      | { type: "report"; progress: number; estimatedRemainingMs?: number }
      | { type: "yield" }
      | { type: "checkpoint" }
      | { type: "resume" }
      | { type: "finish" }
      | { type: "error" }
      | { type: "stale" }
      | { type: "archive" },
  },
}).createMachine({
  id: "adaptive-subagent",
  initial: "created",
  context: ({ input }) => ({
    sessionKey: input.sessionKey,
    progress: 0,
    lastReportAtMs: 0,
    estimatedRemainingMs: null,
    staleCount: 0,
  }),
  states: {
    created: {
      on: {
        dispatch: "dispatched",
      },
    },
    dispatched: {
      on: {
        start: "running",
        error: "failed",
      },
    },
    running: {
      on: {
        report: {
          target: "running",
          actions: assign({
            progress: ({ event }) => event.progress,
            lastReportAtMs: () => Date.now(),
            estimatedRemainingMs: ({ event }) => event.estimatedRemainingMs ?? null,
          }),
        },
        yield: "yielding",
        finish: "completed",
        error: "failed",
        stale: {
          target: "stale",
          actions: assign({
            staleCount: ({ context }) => context.staleCount + 1,
          }),
        },
      },
    },
    yielding: {
      // Graceful checkpoint — subagent can save state and exit
      on: {
        checkpoint: "completed",
        resume: "running",
        error: "failed",
      },
    },
    stale: {
      // Missed a report — not killed, but marked
      // Parent will yield to let it checkpoint
      on: {
        report: {
          target: "running",
          actions: assign({
            progress: ({ event }) => event.progress,
            lastReportAtMs: () => Date.now(),
          }),
        },
        yield: "yielding",
        finish: "completed",
        error: "failed",
      },
    },
    completed: {
      on: { archive: "archived" },
    },
    failed: {
      on: { archive: "archived" },
    },
    archived: {
      type: "final",
    },
  },
})
