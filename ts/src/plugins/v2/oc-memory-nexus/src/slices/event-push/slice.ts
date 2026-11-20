/**
 * Event Push Slice Adapter — binds after_tool_call M1 delivery using typed PluginApi workflow.
 *
 * @invariants
 * - Zero any casts; returns typed telemetry events to the composition root.
 *
 * @dft
 * - Tested via oc-memory-nexus integration specs with InMemoryPluginApi.
 */

import type { PluginApi, HookEvent, HookContext } from "../../../../../shared/types.js";
import type { NoteRegistry } from "../../memory-recall-logic.js";
import { createEventPushSliceState } from "./state.js";
import { stepEventPush } from "./logic.js";

export interface EventPushSliceHandle {
  onAfterToolCall: (
    event: HookEvent,
    ctx: HookContext | undefined,
    registry: NoteRegistry,
  ) => Promise<Array<{ kind: string; arm: string }>>;
}

export function bindEventPushSlice(
  api: PluginApi,
  clock: () => number = () => Date.now(),
): EventPushSliceHandle {
  let state = createEventPushSliceState();

  return {
    async onAfterToolCall(event, ctx, registry) {
      try {
        const nowMs = typeof ctx?.nowMs === "number" ? ctx.nowMs : clock();
        const toolName = String(event.toolName ?? ctx?.toolName ?? "");
        const sessionKey = String(ctx?.sessionKey ?? event.sessionKey ?? "default-session");
        const params =
          event.params && typeof event.params === "object"
            ? (event.params as Record<string, unknown>)
            : {};
        const error = typeof event.error === "string" ? event.error : undefined;

        const res = stepEventPush(
          state,
          registry,
          { toolName, params, result: event.result, error, sessionKey },
          nowMs,
        );
        state = res.nextState;

        const enqueueInjection =
          api.session?.workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;

        if (typeof enqueueInjection === "function") {
          for (const item of res.notesToPush) {
            await enqueueInjection({
              sessionKey,
              text: item.cueText,
              idempotencyKey: item.idempotencyKey,
            });
          }
        }
        return res.telemetryEvents;
      } catch (err) {
        api.logger?.warn?.(`[oc-memory-nexus] after_tool_call error: ${String(err)}`);
        return [];
      }
    },
  };
}

