/**
 * Model Routing Slice Adapter — binds model_health tool and model call telemetry hooks.
 *
 * @invariants
 * - Owns only ModelRoutingState; communicates outcomes via return values.
 * - Zero empty catch blocks; all errors logged via api.logger.
 *
 * @dft
 * - Tested via oc-model-nexus integration & manifest specs with InMemoryPluginApi.
 */

import { Type, type PluginApi, type HookEvent, type HookContext } from "../../../../../shared/types.js";
import { createModelRoutingState, type ModelRouterConfig, type ModelRoutingState } from "./state.js";
import {
  recordModelCallStarted,
  recordModelCallEnded,
  buildModelHealthSummary,
} from "./logic.js";

export interface ModelRoutingSliceHandle {
  readonly state: ModelRoutingState;
  onCallStarted: (event: HookEvent, ctx?: HookContext) => void;
  onCallEnded: (
    event: HookEvent,
    ctx?: HookContext,
  ) => { recorded: boolean; model: string; isError: boolean; latencyMs: number };
}

export function bindModelRoutingSlice(
  api: PluginApi,
  config: ModelRouterConfig,
  initialState?: ModelRoutingState,
): ModelRoutingSliceHandle {
  const state = initialState ?? createModelRoutingState();

  api.registerTool({
    name: "model_health",
    description:
      "Report per-model P99 latency, error rate, and current routing decision. Run to check which models are healthy and whether a fallback should be triggered.",
    parameters: Type.Object({}),
    async execute() {
      const summary = buildModelHealthSummary(state, config);
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  });

  return {
    state,
    onCallStarted(event: HookEvent, ctx?: HookContext) {
      recordModelCallStarted(state, event, ctx);
    },
    onCallEnded(event: HookEvent, ctx?: HookContext) {
      const res = recordModelCallEnded(state, config, event, ctx);
      if (res.recorded && res.status === "critical") {
        api.logger?.warn?.(`[oc-model-nexus] model ${res.model} is CRITICAL`);
      }
      return res;
    },
  };
}

