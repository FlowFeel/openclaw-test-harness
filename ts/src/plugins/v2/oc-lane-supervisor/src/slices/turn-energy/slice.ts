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

export type InputGateDecision =
  | { outcome: "pass" }
  | { outcome: "block"; reason: string };

export interface TurnEnergySliceHandle {
  onBeforeAgentRun: (event: HookEvent, ctx?: HookContext) => InputGateDecision;
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

function extractPrompt(event: HookEvent): string | undefined {
  if (typeof event.prompt === "string") {
    return event.prompt;
  }
  const messages = Array.isArray(event.messages) ? event.messages : undefined;
  const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
  if (!last || typeof last !== "object") {
    return undefined;
  }
  const content = (last as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .filter(Boolean);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

export function bindTurnEnergySlice(
  config: TurnEnergySliceConfig,
  clock: () => number = () => Date.now(),
): TurnEnergySliceHandle {
  const state = createTurnEnergySliceState();

  return {
    onBeforeAgentRun(event: HookEvent, ctx?: HookContext): InputGateDecision {
      const sessionId = resolveSessionId(event, ctx);
      const prompt = extractPrompt(event);
      const trigger = typeof ctx?.trigger === "string" ? ctx.trigger : undefined;
      const isHeartbeat = ctx?.isHeartbeat === true;
      const rawSessionKey = ctx?.sessionKey ?? event.sessionKey;
      const isNonHeartbeatUserSession =
        typeof rawSessionKey === "string" &&
        rawSessionKey.length > 0 &&
        !rawSessionKey.includes(":heartbeat") &&
        trigger !== "heartbeat" &&
        !isHeartbeat;
      const isInteractiveChannel = Boolean(
        event.channelId ||
          event.senderId ||
          ctx?.channelId ||
          ctx?.chatId ||
          ctx?.topicId ||
          isNonHeartbeatUserSession,
      );
      const res = startTurnEnergy(state, config, sessionId, prompt, clock(), {
        trigger,
        isHeartbeat,
        isInteractiveChannel,
      });
      if (res.suppressed) {
        return {
          outcome: "block",
          reason: res.reason || "Idle heartbeat suppressed — zero model calls when idle",
        };
      }
      return { outcome: "pass" };
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

