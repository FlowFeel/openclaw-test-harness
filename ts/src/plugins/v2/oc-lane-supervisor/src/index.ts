/**
 * Unified Lane Supervisor — Declarative Vertical Slice Composer (Plugins v2).
 *
 * @invariants
 * - Zero closure-trapped mutable state: each capability owns its own isolated state slice.
 * - Cross-slice coordination occurs strictly via typed value contracts (e.g., isZeroDeltaPoll).
 * - Zero unreachable files (idle-guard-logic wired), zero no-op hooks (subagent semaphore wired).
 *
 * @dft
 * - Full 4-tier test pyramid: slice unit tests, Protocol-double integration + manifest tests,
 *   traceable BDD Gherkin features, and containerized E2E boot gate.
 */

import {
  definePluginEntry,
  type PluginApi,
  type HookEvent,
  type HookContext,
} from "../../../shared/types.js";
import type { SessionTier } from "../../../shared/efficiency-energy-logic.js";
import type { TruncationOptions } from "./tool-result-hygiene-logic.js";
import { DEFAULT_LANE_CAP_MS, DEFAULT_WARN_RATIO } from "./forecaster-logic.js";
import type { SessionsReader, SessionsWriter } from "./sessions-io.js";
import type { HistoryReader } from "./forecaster-io.js";
import { bindTurnEnergySlice } from "./slices/turn-energy/slice.js";
import { bindPollHygieneSlice } from "./slices/poll-hygiene/slice.js";
import { bindToolHygieneSlice } from "./slices/tool-hygiene/slice.js";
import { bindTopicAdmissionSlice } from "./slices/topic-admission/slice.js";
import { bindLaneForecasterSlice } from "./slices/lane-forecaster/slice.js";
import { bindTopicRecoverySlice } from "./slices/topic-recovery/slice.js";
import { bindTopicProvisioningSlice } from "./slices/topic-provisioning/slice.js";
import type { TopicProvisioningIO } from "./slices/topic-provisioning/io.js";

export interface LaneSupervisorConfig extends TruncationOptions {
  sessionsPath?: string;
  maxAgeHours?: number;
  bloatFields?: string[];
  suppressIdleHeartbeats?: boolean;
  enablePollDeduplication?: boolean;
  rollupTransientSteps?: boolean;
  rollupMinBurstSize?: number;
  rollupTransientTools?: string[];
  rollupTailChars?: number;
  turnPollBudgetMs?: number;
  enableTurnPollBudget?: boolean;
  maxConsecutiveIdenticalErrors?: number;
  enableErrorCircuitBreaker?: boolean;
  enableEnergyBudget?: boolean;
  enableEnergyEnvelopeHeaders?: boolean;
  initialSessionTier?: SessionTier;
  laneCapMs?: number;
  warningThresholdRatio?: number;
  mainPoolMax?: number;
  subPoolMax?: number;
  maxIdleDays?: number;
  maxMessages?: number;
  sessionsReader?: SessionsReader;
  sessionsWriter?: SessionsWriter;
  historyReader?: HistoryReader;
  topicProvisioningIO?: TopicProvisioningIO;
  enableTopicProvisioning?: boolean;
  workspaceRoot?: string;
  clock?: () => number;
}

const DEFAULT_BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

function resolveSessionId(event?: HookEvent, ctx?: HookContext): string {
  return String(ctx?.sessionId ?? ctx?.sessionKey ?? event?.sessionId ?? event?.sessionKey ?? "default");
}

export default definePluginEntry({
  id: "oc-lane-supervisor",
  name: "OC Lane Supervisor",
  description:
    "Unified Lane Supervisor (Plugins v2) — consolidates turn energy budgeting, habit economics, soft-landing gating, topic admission control, zero-delta frame collapsing, transient tool rollups, and topic registry recovery.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as LaneSupervisorConfig) ?? {};
    const clock = cfg.clock ?? (() => Date.now());

    const energy = bindTurnEnergySlice(
      {
        enabled: cfg.enableEnergyBudget ?? true,
        enableHeaders: cfg.enableEnergyEnvelopeHeaders ?? false,
        initialSessionTier: cfg.initialSessionTier ?? "standard",
        suppressIdleHeartbeats: cfg.suppressIdleHeartbeats ?? true,
      },
      clock,
    );

    const poll = bindPollHygieneSlice(
      {
        enablePollDeduplication: cfg.enablePollDeduplication ?? true,
        enableTurnPollBudget: cfg.enableTurnPollBudget ?? true,
        turnPollBudgetMs: cfg.turnPollBudgetMs ?? 90_000,
      },
      clock,
    );

    const toolHygiene = bindToolHygieneSlice({
      truncation: {
        headChars: cfg.headChars,
        tailChars: cfg.tailChars,
        maxToolResultChars: cfg.maxToolResultChars,
        exemptTools: cfg.exemptTools,
      },
      circuitBreaker: {
        maxConsecutiveIdenticalErrors: cfg.maxConsecutiveIdenticalErrors,
        enableErrorCircuitBreaker: cfg.enableErrorCircuitBreaker,
      },
      rollupEnabled: cfg.rollupTransientSteps ?? true,
      rollup: {
        transientTools: cfg.rollupTransientTools,
        minBurstSize: cfg.rollupMinBurstSize ?? 4,
        tailChars: cfg.rollupTailChars,
      },
    });

    const admission = bindTopicAdmissionSlice(api, {
      mainPoolMax: cfg.mainPoolMax ?? 4,
      subPoolMax: cfg.subPoolMax ?? 6,
    });

    const forecaster = bindLaneForecasterSlice(
      api,
      {
        laneCapMs: cfg.laneCapMs ?? DEFAULT_LANE_CAP_MS,
        warningThresholdRatio: cfg.warningThresholdRatio ?? DEFAULT_WARN_RATIO,
      },
      { historyReader: cfg.historyReader, clock },
    );

    const recovery = bindTopicRecoverySlice(api, {
      sessionsPath: cfg.sessionsPath,
      bloatFields: cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS,
      maxAgeHours: cfg.maxAgeHours ?? 15,
      maxIdleDays: cfg.maxIdleDays ?? 14,
      maxMessages: cfg.maxMessages ?? 2000,
      sessionsReader: cfg.sessionsReader,
      sessionsWriter: cfg.sessionsWriter,
      clock,
      getHealthCard: (sid) => energy.getHealthCard(sid),
    });

    const provisioning = bindTopicProvisioningSlice(api, {
      enabled: cfg.enableTopicProvisioning ?? true,
      workspaceRoot: cfg.workspaceRoot,
      io: cfg.topicProvisioningIO,
      clock,
    });

    api.on("before_dispatch", async (event: HookEvent) => forecaster.onBeforeDispatch(event));
    api.on("before_agent_run", async (event: HookEvent, ctx?: HookContext) => {
      const provisionedEvent = provisioning.onBeforeAgentRun(event, ctx);
      const gate = energy.onBeforeAgentRun(provisionedEvent, ctx);
      if (gate?.block) return gate;
      return provisionedEvent;
    });

    api.on("before_tool_call", (event: HookEvent, ctx?: HookContext) => {
      const toolName = String(event.toolName ?? "");
      const breakerGate = toolHygiene.onBeforeToolCall(toolName, event.params);
      if (breakerGate?.block) return breakerGate;
      return energy.onBeforeToolCall(ctx);
    });

    api.on("tool_result_persist", (event: HookEvent, ctx?: HookContext) => {
      const sessionId = resolveSessionId(event, ctx);
      const toolName = String(event.toolName ?? "");
      const pollRes = poll.onToolResultPersist({ sessionId, toolName, message: event.message });
      const hygieneRes = toolHygiene.onToolResultPersist({ sessionId, toolName, message: pollRes.message });
      const payloadBytes = JSON.stringify(hygieneRes.message ?? "").length;
      energy.onToolResultPersist({
        sessionId,
        toolName,
        isZeroDeltaPoll: pollRes.isZeroDeltaPoll,
        payloadBytes,
      });
      return { ...event, message: hygieneRes.message };
    });

    api.on("before_message_write", (event: HookEvent) => poll.onBeforeMessageWrite(event));
    api.on("agent_end", async (event: HookEvent, ctx?: HookContext) => {
      const sessionId = resolveSessionId(event, ctx);
      toolHygiene.onAgentEnd(sessionId);
      energy.onAgentEnd(event, ctx);
    });
    api.on("after_compaction", async () => recovery.onAfterCompaction());
    api.on("session_end", async () => recovery.onSessionEnd());
    api.on("subagent_spawning", async (event: HookEvent) => admission.onSubagentSpawning(event));
    api.on("subagent_ended", async (event: HookEvent) => admission.onSubagentEnded(event));
  },
});
