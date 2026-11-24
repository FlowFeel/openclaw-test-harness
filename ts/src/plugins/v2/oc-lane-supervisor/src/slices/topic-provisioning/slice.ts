/**
 * Topic Provisioning Slice Adapter — binds session_start, before_agent_run, and
 * before_prompt_build to provision workspaces and deliver Turn 0 orientation.
 *
 * @invariants
 * - Thin adapter: delegates identity extraction to logic.ts, filesystem I/O to io.ts,
 *   and state transitions to state.ts (A1, A5, A6).
 * - Never throws inside fail-closed lifecycle hooks.
 *
 * @dft
 * - Tested via slices/topic-provisioning/tests/slice.spec.ts with InMemoryTopicProvisioningIO.
 */

import type { PluginApi, HookEvent, HookContext } from "../../../../../shared/types.js";
import {
  extractTopicProvisioningContext,
  renderCarePackageSkeleton,
} from "./logic.js";
import {
  NodeFsTopicProvisioningIO,
  scaffoldTopicWorkspace,
  type TopicProvisioningIO,
} from "./io.js";
import {
  createTopicProvisioningSliceState,
  markTopicProvisioned,
  enqueueOrientationInjection,
  dequeueOrientationInjection,
  type TopicProvisioningSliceConfig,
} from "./state.js";

export interface TopicProvisioningSliceHandle {
  onSessionStart: (event: HookEvent, ctx?: HookContext) => void;
  onBeforeAgentRun: (event: HookEvent, ctx?: HookContext) => HookEvent;
  consumeOrientationInjection: (sessionKey: string) => string | undefined;
  isTopicProvisioned: (topicId: number) => boolean;
}

export function bindTopicProvisioningSlice(
  api: PluginApi,
  config: TopicProvisioningSliceConfig = {},
): TopicProvisioningSliceHandle {
  const enabled = config.enabled ?? true;
  const workspaceRoot = config.workspaceRoot ?? "/home/node/.openclaw/workspace";
  const io: TopicProvisioningIO = config.io ?? new NodeFsTopicProvisioningIO();
  const clock = config.clock ?? (() => Date.now());

  let state = createTopicProvisioningSliceState();

  function provision(event: HookEvent, ctx?: HookContext): string | undefined {
    if (!enabled) return undefined;
    const extracted = extractTopicProvisioningContext(event, ctx);
    if (!extracted || state.provisionedTopicIds.has(extracted.topicId)) {
      return undefined;
    }

    const skeleton = renderCarePackageSkeleton({
      topicId: extracted.topicId,
      topicName: extracted.topicName,
      chatId: extracted.chatId,
      sessionKey: extracted.sessionKey,
      createdUtc: new Date(clock()).toISOString(),
      createdBy: extracted.createdBy,
      workspaceRoot,
    });

    const scaffold = scaffoldTopicWorkspace(io, skeleton, workspaceRoot);
    if (!scaffold.ok) {
      api.logger?.warn?.(
        `[oc-lane-supervisor] topic ${extracted.topicId} provisioning I/O failed (fail-open): ${scaffold.error}`,
      );
      return undefined;
    }
    if (scaffold.created) {
      api.logger?.info?.(
        `[oc-lane-supervisor] provisioned topic ${extracted.topicId} workspace at ${skeleton.workspacePath}`,
      );
    }

    state = markTopicProvisioned(state, extracted.topicId);
    state = enqueueOrientationInjection(state, extracted.injectionKey, skeleton.summaryInjection);
    return skeleton.summaryInjection;
  }

  return {
    onSessionStart(event: HookEvent, ctx?: HookContext): void {
      provision(event, ctx);
    },
    onBeforeAgentRun(event: HookEvent, ctx?: HookContext): HookEvent {
      const summaryInjection = provision(event, ctx);
      if (!summaryInjection) return event;
      const existingContext = typeof event.prompt === "string" ? event.prompt : "";
      if (existingContext.includes("[Topic Orientation]")) return event;
      return {
        ...event,
        prompt: existingContext ? `${summaryInjection}\n\n${existingContext}` : summaryInjection,
      };
    },
    consumeOrientationInjection(sessionKey: string): string | undefined {
      const { nextState, brief } = dequeueOrientationInjection(state, sessionKey);
      state = nextState;
      return brief;
    },
    isTopicProvisioned: (topicId: number) => state.provisionedTopicIds.has(topicId),
  };
}
