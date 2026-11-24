/**
 * Pure Turn Action Counter Algebra — immutable per-turn action counts,
 * streaks, and density/cadence queries.
 *
 * @invariants
 * - Pure deterministic value algebra: zero I/O, zero clocks, zero regexes (A1, A2, A6).
 * - Single authoritative owner of totalActions, delegationActions, pipelineActions,
 *   serialExecStreak, and zeroDeltaPolls.
 *
 * @dft
 * - Tested directly via ts/tests/efficiency/action-counter.spec.ts.
 */

export type ActionEconomicKind =
  | "delegation"
  | "pipeline"
  | "serial_exec"
  | "zero_delta_poll"
  | "duplicate_args"
  | "poll"
  | "targeted_read"
  | "cached_read"
  | "standard";

export interface TurnActionCounters {
  readonly totalActions: number;
  readonly delegationActions: number;
  readonly pipelineActions: number;
  readonly serialExecStreak: number;
  readonly zeroDeltaPolls: number;
}

export function createTurnActionCounters(): TurnActionCounters {
  return {
    totalActions: 0,
    delegationActions: 0,
    pipelineActions: 0,
    serialExecStreak: 0,
    zeroDeltaPolls: 0,
  };
}

/**
 * Pure transition recording a classified tool action into per-turn counters.
 * Delegation and pipeline actions reset the serial exec streak to 0.
 */
export function recordTurnAction(
  counters: TurnActionCounters,
  kind: ActionEconomicKind,
): TurnActionCounters {
  const nextTotal = counters.totalActions + 1;

  if (kind === "delegation") {
    return {
      ...counters,
      totalActions: nextTotal,
      delegationActions: counters.delegationActions + 1,
      serialExecStreak: 0,
    };
  }

  if (kind === "pipeline") {
    return {
      ...counters,
      totalActions: nextTotal,
      pipelineActions: counters.pipelineActions + 1,
      serialExecStreak: 0,
    };
  }

  if (kind === "serial_exec") {
    return {
      ...counters,
      totalActions: nextTotal,
      serialExecStreak: counters.serialExecStreak + 1,
    };
  }

  if (kind === "zero_delta_poll") {
    return {
      ...counters,
      totalActions: nextTotal,
      zeroDeltaPolls: counters.zeroDeltaPolls + 1,
    };
  }

  return {
    ...counters,
    totalActions: nextTotal,
  };
}

/** Number of unbatched serial exec calls beyond the configured threshold. */
export function serialExecOverflow(
  counters: TurnActionCounters,
  threshold: number,
): number {
  return Math.max(0, counters.serialExecStreak - threshold);
}

/** True when total turn actions meet or exceed the high-density threshold. */
export function exceedsActionDensity(
  counters: TurnActionCounters,
  maxActions: number,
): boolean {
  return counters.totalActions >= maxActions;
}

/** Actions elapsed since a prior action count, or null if never emitted. */
export function actionsSince(
  counters: TurnActionCounters,
  priorTotalActions: number | null,
): number | null {
  if (priorTotalActions === null) return null;
  return counters.totalActions - priorTotalActions;
}
