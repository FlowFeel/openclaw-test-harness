/**
 * Tool Hygiene Slice Adapter — binds circuit breaker, truncation, and burst rollup hooks.
 *
 * @invariants
 * - Owns only ToolHygieneSliceState; zero direct I/O.
 *
 * @dft
 * - Tested via oc-lane-supervisor integration specs.
 */

import { createToolHygieneSliceState, type ToolHygieneSliceConfig } from "./state.js";
import {
  checkToolCircuitBreaker,
  applyToolResultHygiene,
  finalizeSessionRollup,
} from "./logic.js";

export interface ToolHygieneSliceHandle {
  onBeforeToolCall: (toolName: string, params: unknown) => { block?: boolean; blockReason?: string } | undefined;
  onToolResultPersist: (params: {
    sessionId: string;
    toolName: string;
    message: unknown;
  }) => { message: unknown; truncated: boolean };
  onAgentEnd: (sessionId: string) => { squashedCount: number };
}

export function bindToolHygieneSlice(config: ToolHygieneSliceConfig): ToolHygieneSliceHandle {
  let state = createToolHygieneSliceState();

  return {
    onBeforeToolCall(toolName: string, params: unknown) {
      const gate = checkToolCircuitBreaker(state, config, toolName, params);
      return gate.blocked ? { block: true, blockReason: gate.blockReason } : undefined;
    },
    onToolResultPersist(params) {
      const res = applyToolResultHygiene(state, config, params);
      state = res.nextState;
      return { message: res.message, truncated: res.truncated };
    },
    onAgentEnd(sessionId: string) {
      return finalizeSessionRollup(state, config, sessionId);
    },
  };
}

