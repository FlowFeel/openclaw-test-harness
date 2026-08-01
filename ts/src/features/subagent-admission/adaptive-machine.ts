/**
 * XState-free pure functional state machine for adaptive subagent lifecycle.
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
 * - A yielding subagent can checkpoint and transition to "completed"
 * - The machine tracks progress (0.0 to 1.0) and estimated time
 */

export type AdaptiveState =
  | "created"
  | "dispatched"
  | "running"
  | "yielding"
  | "stale"
  | "completed"
  | "failed"
  | "archived"

export type AdaptiveEvent =
  | { type: "dispatch" }
  | { type: "start" }
  | { type: "report"; progress: number; estimatedRemainingMs?: number }
  | { type: "yield" }
  | { type: "checkpoint" }
  | { type: "resume" }
  | { type: "finish" }
  | { type: "error" }
  | { type: "stale" }
  | { type: "archive" }

export interface AdaptiveContext {
  sessionKey: string
  progress: number
  lastReportAtMs: number
  estimatedRemainingMs: number | null
  staleCount: number
}

export const ADAPTIVE_TRANSITIONS: Record<AdaptiveState, Partial<Record<AdaptiveEvent["type"], AdaptiveState>>> = {
  created: {
    dispatch: "dispatched",
  },
  dispatched: {
    start: "running",
    error: "failed",
  },
  running: {
    report: "running",
    yield: "yielding",
    finish: "completed",
    error: "failed",
    stale: "stale",
  },
  yielding: {
    checkpoint: "completed",
    resume: "running",
    error: "failed",
  },
  stale: {
    report: "running",
    yield: "yielding",
    finish: "completed",
    error: "failed",
  },
  completed: {
    archive: "archived",
  },
  failed: {
    archive: "archived",
  },
  archived: {},
}

/**
 * Pure transition function for the state value.
 */
export function transitionAdaptiveState(state: AdaptiveState, eventType: AdaptiveEvent["type"]): AdaptiveState {
  const next = ADAPTIVE_TRANSITIONS[state][eventType]
  if (!next) {
    if (state === "archived") {
      return "archived"
    }
    return state
  }
  return next
}

/**
 * Pure context reducer function. Updates the context based on current context and event.
 */
export function reduceAdaptiveContext(
  context: AdaptiveContext,
  event: AdaptiveEvent,
  nowMs: number = Date.now()
): AdaptiveContext {
  switch (event.type) {
    case "report":
      return {
        ...context,
        progress: event.progress,
        lastReportAtMs: nowMs,
        estimatedRemainingMs: event.estimatedRemainingMs ?? null,
      }
    case "stale":
      return {
        ...context,
        staleCount: context.staleCount + 1,
      }
    default:
      return context
  }
}

/**
 * A lightweight, zero-dependency actor-like wrapper to preserve compatibility
 * with tests that use xstate-like `createActor(machine)` APIs.
 */
export class AdaptiveSubagentActor {
  private currentState: AdaptiveState = "created"
  private currentContext: AdaptiveContext

  constructor(sessionKey: string) {
    this.currentContext = {
      sessionKey,
      progress: 0,
      lastReportAtMs: 0,
      estimatedRemainingMs: null,
      staleCount: 0,
    }
  }

  start() {
    this.currentState = "created"
    return this
  }

  send(event: AdaptiveEvent) {
    this.currentState = transitionAdaptiveState(this.currentState, event.type)
    this.currentContext = reduceAdaptiveContext(this.currentContext, event)
  }

  getSnapshot() {
    return {
      value: this.currentState,
      context: this.currentContext,
    }
  }
}

export const adaptiveSubagentMachine = {
  createActor: (input: { sessionKey: string }) => new AdaptiveSubagentActor(input.sessionKey)
}
