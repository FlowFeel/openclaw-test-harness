/**
 * Topic Provisioning Slice Adapter — binds before_agent_run to provision workspace and drop care package.
 *
 * @invariants
 * - Pure I/O mediated via TopicProvisioningIO (A1, A5).
 * - Idempotent: checks in-memory state and disk presence before touching filesystem.
 *
 * @dft
 * - Tested via slices/topic-provisioning/tests/slice.spec.ts with InMemoryTopicProvisioningIO.
 */

import type { PluginApi, HookEvent, HookContext } from "../../../../../shared/types.js";
import {
  renderCarePackageSkeleton,
  type CarePackageSkeleton,
} from "./logic.js";
import { NodeFsTopicProvisioningIO, type TopicProvisioningIO } from "./io.js";
import {
  createTopicProvisioningSliceState,
  markTopicProvisioned,
  type TopicProvisioningSliceConfig,
} from "./state.js";

export interface TopicProvisioningSliceHandle {
  onBeforeAgentRun: (event: HookEvent, ctx?: HookContext) => HookEvent;
  consumeOrientationInjection: (sessionKey: string) => string | undefined;
  isTopicProvisioned: (topicId: number) => boolean;
}

function parseTopicId(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
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
  const pendingInjections = new Map<string, string>();

  return {
    onBeforeAgentRun(event: HookEvent, ctx?: HookContext): HookEvent {
      if (!enabled) return event;

      const rawTopicId =
        ctx?.topicId ??
        event?.topicId ??
        (ctx as Record<string, unknown> | undefined)?.threadId ??
        (event as Record<string, unknown> | undefined)?.threadId;

      const topicId = parseTopicId(rawTopicId);
      if (!topicId) return event;

      // In-memory cache hit: already provisioned in this daemon lifecycle
      if (state.provisionedTopicIds.has(topicId)) {
        return event;
      }

      const topicName =
        String(ctx?.topicName ?? event?.topicName ?? `Topic ${topicId}`);
      const chatId = String(ctx?.chatId ?? event?.chatId ?? "telegram:default");
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey ? String(ctx?.sessionKey ?? event?.sessionKey) : null;
      const createdUtc = new Date(clock()).toISOString();

      const rawCreatedBy =
        (ctx as Record<string, unknown> | undefined)?.sender ??
        (ctx as Record<string, unknown> | undefined)?.senderName ??
        (ctx as Record<string, unknown> | undefined)?.senderId ??
        (ctx as Record<string, unknown> | undefined)?.createdBy ??
        (event as Record<string, unknown> | undefined)?.sender ??
        (event as Record<string, unknown> | undefined)?.senderName ??
        (event as Record<string, unknown> | undefined)?.senderId ??
        (event as Record<string, unknown> | undefined)?.createdBy;
      const createdBy = rawCreatedBy ? String(rawCreatedBy) : "system";

      const skeleton: CarePackageSkeleton = renderCarePackageSkeleton({
        topicId,
        topicName,
        chatId,
        sessionKey,
        createdUtc,
        createdBy,
        workspaceRoot,
      });

      // Check if care package already exists on disk (never throw inside fail-closed before_agent_run)
      const absolutePath = `${workspaceRoot}/${skeleton.carePackageRelativePath}`;
      try {
        const alreadyOnDisk = io.existsSync(absolutePath);

        if (!alreadyOnDisk) {
          // Scaffolding directories: work/topic-<id>-<slug>/{docs,scripts,tests,state}
          io.mkdirSync(`${skeleton.workspacePath}/docs`, { recursive: true });
          io.mkdirSync(`${skeleton.workspacePath}/scripts`, { recursive: true });
          io.mkdirSync(`${skeleton.workspacePath}/tests`, { recursive: true });
          io.mkdirSync(`${skeleton.workspacePath}/state`, { recursive: true });

          // Ensure archive directory exists and write care package
          const archiveDir = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
          io.mkdirSync(archiveDir, { recursive: true });
          io.writeFileSync(absolutePath, skeleton.markdown, "utf-8");

          api.logger?.info?.(
            `[oc-lane-supervisor] provisioned topic ${topicId} workspace at ${skeleton.workspacePath}`,
          );
        }
      } catch (err) {
        api.logger?.warn?.(
          `[oc-lane-supervisor] topic ${topicId} provisioning I/O failed (fail-open): ${String(err)}`,
        );
        return event;
      }

      state = markTopicProvisioned(state, topicId);

      // Queue Turn 0 orientation brief for before_prompt_build (before_agent_run is gate-only)
      const injectionKey = String(
        ctx?.sessionId ?? ctx?.sessionKey ?? event?.sessionId ?? event?.sessionKey ?? `topic:${topicId}`,
      );
      pendingInjections.set(injectionKey, skeleton.summaryInjection);

      // Preserve prompt return for direct unit tests on slice.onBeforeAgentRun
      const existingContext = typeof event.prompt === "string" ? event.prompt : "";
      if (!existingContext.includes("[Topic Orientation]")) {
        return {
          ...event,
          prompt: existingContext
            ? `${skeleton.summaryInjection}\n\n${existingContext}`
            : skeleton.summaryInjection,
        };
      }

      return event;
    },
    consumeOrientationInjection(sessionKey: string): string | undefined {
      const brief = pendingInjections.get(sessionKey);
      if (brief !== undefined) {
        pendingInjections.delete(sessionKey);
      }
      return brief;
    },
    isTopicProvisioned: (topicId: number) => state.provisionedTopicIds.has(topicId),
  };
}
