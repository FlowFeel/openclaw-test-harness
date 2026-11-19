/**
 * Lane Forecaster Pure Transition Algebra — pre-dispatch classification and run timing.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns explicit CheckResult records (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/lane-forecaster/tests/logic.spec.ts.
 */

import {
  classifyAndForecast,
  formatLaneTelemetry,
  type SessionRunHistory,
} from "../../forecaster-logic.js";
import type { LaneForecasterSliceConfig, LaneForecasterSliceState } from "./state.js";

export function forecastDispatchRun(
  state: LaneForecasterSliceState,
  config: LaneForecasterSliceConfig,
  params: {
    prompt: string;
    command?: string;
    sessionKey?: string;
    topicId?: string | number;
    history?: SessionRunHistory;
    nowMs: number;
  },
) {
  if (params.sessionKey) {
    state.activeRunStarts.set(params.sessionKey, params.nowMs);
  }
  const result = classifyAndForecast(
    {
      prompt: params.prompt,
      command: params.command,
      sessionKey: params.sessionKey,
      topicId: params.topicId,
      history: params.history,
    },
    {
      nowMs: params.nowMs,
      laneCapMs: config.laneCapMs,
      warningThresholdRatio: config.warningThresholdRatio,
    },
  );
  return {
    ...result,
    telemetryLine: formatLaneTelemetry({
      topicId: params.topicId,
      predictedDurationMs: result.prediction.predictedDurationMs,
      exceedsCap: result.prediction.exceedsCap,
      shape: result.prediction.shape,
    }),
  };
}
