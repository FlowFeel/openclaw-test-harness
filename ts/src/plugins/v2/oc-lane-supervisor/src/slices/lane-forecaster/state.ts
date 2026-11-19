/**
 * Lane Forecaster State Slice — tracks active run start timestamps for duration recording.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to energy or topic-recovery slices.
 *
 * @dft
 * - Tested directly via slices/lane-forecaster/tests/logic.spec.ts.
 */

export interface LaneForecasterSliceConfig {
  laneCapMs: number;
  warningThresholdRatio: number;
}

export interface LaneForecasterSliceState {
  readonly activeRunStarts: Map<string, number>;
}

export function createLaneForecasterState(): LaneForecasterSliceState {
  return { activeRunStarts: new Map() };
}

