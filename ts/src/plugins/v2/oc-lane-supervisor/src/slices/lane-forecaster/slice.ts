/**
 * Lane Forecaster Slice Adapter — binds lane_forecast tool and before_dispatch forecasting.
 *
 * @invariants
 * - History I/O mediated via injectable HistoryReader protocol.
 *
 * @dft
 * - Tested via oc-lane-supervisor integration & manifest specs.
 */

import { Type, type PluginApi, type HookEvent } from "../../../../../shared/types.js";
import { defaultHistoryStore, type HistoryReader } from "../../forecaster-io.js";
import { createLaneForecasterState, type LaneForecasterSliceConfig } from "./state.js";
import { forecastDispatchRun } from "./logic.js";

export interface LaneForecasterSliceHandle {
  onBeforeDispatch: (event: HookEvent) => HookEvent;
}

export function bindLaneForecasterSlice(
  api: PluginApi,
  config: LaneForecasterSliceConfig,
  opts?: { historyReader?: HistoryReader; clock?: () => number },
): LaneForecasterSliceHandle {
  const state = createLaneForecasterState();
  const historyReader = opts?.historyReader ?? defaultHistoryStore.read;
  const clock = opts?.clock ?? (() => Date.now());

  api.registerTool({
    name: "lane_forecast",
    description:
      "Predict execution duration against the lane cap and provide advisory recommendations.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Task prompt text" }),
      command: Type.Optional(Type.String({ description: "Optional shell command" })),
      sessionKey: Type.Optional(Type.String({ description: "Optional session key" })),
    }),
    async execute(_id, params) {
      const prompt = String(params.prompt ?? "");
      const command = typeof params.command === "string" ? params.command : undefined;
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
      const history = sessionKey ? historyReader(sessionKey) ?? undefined : undefined;
      const forecast = forecastDispatchRun(state, config, {
        prompt,
        command,
        sessionKey,
        history,
        nowMs: clock(),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(forecast, null, 2) }] };
    },
  });

  return {
    onBeforeDispatch(event: HookEvent) {
      try {
        const sessionKey = String(event.sessionKey ?? "");
        const prompt = String(event.content ?? event.prompt ?? "");
        const history = sessionKey ? historyReader(sessionKey) ?? undefined : undefined;
        const forecast = forecastDispatchRun(state, config, {
          prompt,
          sessionKey,
          history,
          nowMs: clock(),
        });
        if (forecast.prediction.exceedsCap) {
          api.logger?.warn?.(`[oc-lane-supervisor] ${forecast.telemetryLine}`);
        }
      } catch (err) {
        api.logger?.warn?.(`[oc-lane-supervisor] before_dispatch forecast failed: ${String(err)}`);
      }
      return event;
    },
  };
}
