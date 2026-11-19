/**
 * Stream Relay Slice Adapter — binds stream_relay_health tool and receives call outcomes.
 *
 * @invariants
 * - Owns only RelayState; no global singletons, no direct network I/O.
 *
 * @dft
 * - Tested via oc-model-nexus integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import { createRelayState, type RelayState, type StreamRelayConfig } from "./state.js";
import { recordRelayOutcome, formatRelayHealth } from "./logic.js";

export interface StreamRelaySliceHandle {
  getState: () => RelayState;
  recordCallOutcome: (outcome: { success: boolean; latencyMs: number }) => void;
}

export function bindStreamRelaySlice(
  api: PluginApi,
  config: StreamRelayConfig,
  clock: () => number = () => Date.now(),
): StreamRelaySliceHandle {
  let state = createRelayState(config.sidecarPort, clock());

  api.registerTool({
    name: "stream_relay_health",
    description:
      "Check the health of the stream relay — relay process status, latency statistics, fallback mode, and relay counts.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(formatRelayHealth(state, clock()), null, 2) },
        ],
      };
    },
  });

  return {
    getState: () => state,
    recordCallOutcome(outcome: { success: boolean; latencyMs: number }) {
      const transition = recordRelayOutcome(state, outcome, config);
      state = transition.nextState;
      if (transition.enteredFallback) {
        api.logger?.warn?.("[oc-model-nexus] stream relay entered fallback mode");
      }
    },
  };
}

