/**
 * Turn Energy Slice Adapter — binds turn-energy lifecycle transitions.
 *
 * @invariants
 * - Owns only TurnEnergySliceState; zero direct I/O.
 *
 * @dft
 * - Tested via oc-lane-supervisor integration specs with InMemoryPluginApi.
 */

import type { HookEvent, HookContext } from "../../../../../shared/types.js";
import { createTurnEnergySliceState, type TurnEnergySliceConfig } from "./state.js";
import {
  startTurnEnergy,
  evaluateEnergyGate,
  applyToolEnergyDrain,
  finalizeTurnEnergy,
  getSessionHealthCard,
} from "./logic.js";

export interface TurnEnergySliceHandle {
  onBeforeAgentRun: (event: HookEvent, ctx?: HookContext) => { block?: boolean; blockReason?: string } | undefined;
  onBeforeToolCall: (ctx?: HookContext) => { block?: boolean; blockReason?: string } | undefined;
  onToolResultPersist: (params: {
    sessionId: string;
    toolName: string;
    isZeroDeltaPoll: boolean;
    payloadBytes: number;
  }) => void;
  onAgentEnd: (event: HookEvent, ctx?: HookContext) => void;
  getHealthCard: (sessionId: string) => ReturnType<typeof getSessionHealthCard>;
}

function resolveSessionId(event?: HookEvent, ctx?: HookContext): string {
  return String(ctx?.sessionId ?? ctx?.sessionKey ?? event?.sessionId ?? event?.sessionKey ?? "default");
}

export function bindTurnEnergySlice(
  config: TurnEnergySliceConfig,
  clock: () => number = () => Date.now(),
): TurnEnergySliceHandle {
  const state = createTurnEnergySliceState();

  return {
    onBeforeAgentRun(event: HookEvent, ctx?: HookContext) {
      const sessionId = resolveSessionId(event, ctx);
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      const res = startTurnEnergy(state, config, sessionId, prompt, clock());
      if (res.suppressed) {
        return { block: true, blockReason: res.reason };
      }
      return undefined;
    },
    onBeforeToolCall(ctx?: HookContext) {
      const sessionId = resolveSessionId(undefined, ctx);
      const gate = evaluateEnergyGate(state, config, sessionId);
      if (gate.blocked) {
        return { block: true, blockReason: gate.blockReason };
      }
      return undefined;
    },
    onToolResultPersist(params) {
      applyToolEnergyDrain(state, config, { ...params, nowMs: clock() });
    },
    onAgentEnd(event: HookEvent, ctx?: HookContext) {
      const sessionId = resolveSessionId(event, ctx);
      const producedVisibleReply = event.producedVisibleReply !== false;
      finalizeTurnEnergy(state, config, sessionId, clock(), producedVisibleReply);
    },
    getHealthCard(sessionId: string) {
      return getSessionHealthCard(state, sessionId);
    },
  };
}

