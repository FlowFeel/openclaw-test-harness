/**
 * Unified Memory Nexus Engine — Declarative Vertical Slice Composer (Plugins v2).
 *
 * @invariants
 * - Zero closure-trapped mutable state: each slice owns its own immutable state and reducer.
 * - Zero stubbed tools: compact_check, compact_delta, and sanitize_transcript execute real seams.
 * - Zero any casts, zero empty catch blocks, zero unreachable files.
 *
 * @dft
 * - Full 4-tier test pyramid: slice unit tests, Protocol-double integration + manifest specs,
 *   traceable BDD Gherkin features, and containerized E2E boot gate.
 */

import {
  definePluginEntry,
  type PluginApi,
  type HookEvent,
  type HookContext,
} from "../../../shared/types.js";
import type { MemoryNotesLoader } from "./memory-recall-io.js";
import type { SidecarClient } from "./sidecar-client.js";
import { bindRecallRegistrySlice } from "./slices/recall-registry/slice.js";
import { bindEventPushSlice } from "./slices/event-push/slice.js";
import { bindCompactionSlice, type CompactionIoDeps } from "./slices/compaction/slice.js";
import { bindCpuSidecarSlice } from "./slices/cpu-sidecar/slice.js";

export interface MemoryNexusConfig extends CompactionIoDeps {
  autoCompactionEnabled?: boolean;
  autoCompactionThresholdMb?: number;
  maxTranscriptMb?: number;
  watchedPaths?: string[];
  notesDir?: string;
  subdirs?: string[];
  notesLoader?: MemoryNotesLoader;
  sidecarPort?: number;
  sidecarClient?: SidecarClient;
}

export default definePluginEntry({
  id: "oc-memory-nexus",
  name: "OC Memory Nexus",
  description:
    "Unified Memory Nexus Engine (Plugins v2) — consolidates transcript sanitization & compaction, memory note delivery arms & telemetry, and off-loop CPU sidecar workers.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as MemoryNexusConfig) ?? {};
    const clock = cfg.clock ?? (() => Date.now());

    const recall = bindRecallRegistrySlice(api, {
      notesDir: cfg.notesDir ?? "memory",
      subdirs: Array.isArray(cfg.subdirs) ? cfg.subdirs.map(String) : [],
      notesLoader: cfg.notesLoader,
    });

    const eventPush = bindEventPushSlice(api, clock);

    const compaction = bindCompactionSlice(
      api,
      {
        autoCompactionEnabled: cfg.autoCompactionEnabled ?? true,
        autoCompactionThresholdMb: cfg.autoCompactionThresholdMb ?? 2,
        maxTranscriptMb: cfg.maxTranscriptMb ?? 5,
        watchedPaths: Array.isArray(cfg.watchedPaths) ? cfg.watchedPaths.map(String) : [],
      },
      cfg,
    );

    const sidecar = bindCpuSidecarSlice(api, {
      port: cfg.sidecarPort ?? 18900,
      client: cfg.sidecarClient,
    });

    api.on("gateway_start", async () => {
      recall.reload();
      sidecar.onStart();
    });

    api.on("gateway_stop", async () => {
      sidecar.onStop();
    });

    api.on("after_tool_call", async (event: HookEvent, ctx?: HookContext) => {
      if (recall.getRegistry().notes.size === 0) recall.reload();
      const telemetryEvents = await eventPush.onAfterToolCall(event, ctx, recall.getRegistry());
      if (telemetryEvents.length > 0) {
        recall.recordTelemetry(telemetryEvents);
      }
    });

    api.on("before_agent_reply", async (event: HookEvent) => {
      return recall.onBeforeAgentReply(event);
    });

    api.on("before_compaction", async () => {
      compaction.onBeforeCompaction();
    });
  },
});
