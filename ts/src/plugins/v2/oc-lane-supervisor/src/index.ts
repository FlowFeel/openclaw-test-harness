/**
 * Unified Lane Supervisor — Plugins v2 Core Entry Point.
 *
 * @behavior
 * Consolidates topic admission control, pre-dispatch duration forecasting,
 * turn energy budgeting, habit economics, soft-landing gating, zero-delta frame
 * compaction, transient burst rollups, and topic registry hygiene into a single
 * deterministic supervisor engine.
 *
 * Absorbs:
 * - oc-session-guard
 * - oc-lane-forecaster
 * - oc-topic-worker-pool
 * - oc-topic-manager
 *
 * @invariants
 * - Pure logic / IO separation: all pure logic modules in *-logic.ts.
 * - Strict determinism: all time injected via parameters or clock provider.
 * - Conforms bidirectionally to openclaw.plugin.json contracts.
 * - Real protocol doubles supported via dependency injection.
 *
 * @dft
 * - Tested with in-memory test doubles and real containerized E2E runs.
 */

import { definePluginEntry, Type, type PluginApi } from "../../../shared/types.js";

// ── Shared Economics Seams ──────────────────────────────────────────
import {
  initTurnEnergy,
  applyEnergyAction,
  evaluateTurnEfficiencyScore,
  resolveTierFromTes,
  updateSessionReputation,
  formatEnergyEnvelopeHeader,
  formatHabitTelemetryCard,
  calibrateEconomicParameters,
  DEFAULT_ENERGY_CONFIG,
  type TurnEnergyState,
  type SessionTier,
  type SessionReputation,
  type TurnEnergyConfig,
  type EmpiricalCalibrationProfile,
} from "../../../shared/efficiency-energy-logic.js";
import {
  cleanupSessions,
  type CleanupReport,
  type SessionsMap,
} from "../../../shared/session-cleanup.js";

// ── Session Guard Seams ─────────────────────────────────────────────
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "./sessions-io.js";
import {
  applyToolResultTruncation,
  DEFAULT_MAX_CHARS,
  type TruncationOptions,
} from "./tool-result-hygiene-logic.js";
import {
  compactZeroDeltaPollMessage,
  evaluateMessageWriteSuppression,
  createInitialPollDeduplicationState,
  type PollDeduplicationState,
} from "./poll-hygiene-logic.js";
import {
  evaluateTurnPollBudget,
  createInitialTurnPollState,
  type TurnPollState,
  type PollBudgetConfig,
} from "./poll-hygiene-logic.js";
import {
  evaluatePreToolCallCircuitBreaker,
  recordToolCallOutcome,
  createInitialCircuitBreakerState,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
} from "./tool-result-hygiene-logic.js";
import {
  createTurnBurstTracker,
  recordToolResultForRollup,
  finalizeTurnRollup,
  rollupTransientSteps,
  type RollupOptions,
  type TurnBurstTracker,
} from "./rollup-logic.js";
import {
  formatCleanupLog,
  formatPurgeLog,
  formatHealthReport,
  MESSAGES,
  HEARTBEAT_CONTEXT_GUIDANCE_REGEX,
  HEARTBEAT_OK_PROMPT_REGEX,
  HEARTBEAT_TOOL_PROMPT_REGEX,
  HEARTBEAT_POLL_REGEX,
} from "./utils.js";

// ── Forecaster Seams ────────────────────────────────────────────────
import {
  classifyAndForecast,
  formatLaneTelemetry,
  DEFAULT_LANE_CAP_MS,
  DEFAULT_WARN_RATIO,
} from "./forecaster-logic.js";
import {
  defaultHistoryStore,
  type HistoryReader,
  type HistoryWriter,
} from "./forecaster-io.js";

// ── Topic Manager Seams ─────────────────────────────────────────────
import { parseTopics } from "./parse-topics.js";
import { detectOrphans } from "./detect-orphans.js";
import { decideArchival } from "./archival-policy.js";
import { buildRecoveryPlan, sessionKeyFor } from "./recovery-plan.js";
import {
  readRegistrations,
  readRegistry,
  readTranscriptSizes,
  writeRecoveryPlan,
} from "./registry-io.js";
import { auditPrecheck } from "./audit-precheck.js";
import { evaluateTopicsHealth } from "./health-logic.js";
import type { SessionRegistration, TopicAuditReport, RecoveryApplication } from "./topic-manager-types.js";

// ── Worker Pool Seams ───────────────────────────────────────────────
import {
  createSemaphore,
  acquire,
  release,
  reconcilePool,
  parseTopicSessionKey,
  decideDispatch,
  buildDedupKey,
  hashContent,
  type SemaphoreState,
  type TopicRoutingConfig,
} from "./topic-worker-pool-logic.js";

export interface LaneSupervisorConfig extends TruncationOptions {
  sessionsPath?: string;
  maxAgeHours?: number;
  stripBloatFields?: boolean;
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
  enableForecasterTelemetry?: boolean;
  enableWorkerPool?: boolean;
  mainPoolMax?: number;
  subPoolMax?: number;
  acquireTimeoutMs?: number;
  maxIdleDays?: number;
  maxMessages?: number;
}

const DEFAULT_BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

function asTopicId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return null;
}

function asRegistrations(value: unknown): SessionRegistration[] {
  if (!Array.isArray(value)) return [];
  const out: SessionRegistration[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { topicId?: unknown; sessionKey?: unknown };
    const topicId = asTopicId(rec.topicId);
    if (topicId === null || typeof rec.sessionKey !== "string") continue;
    out.push({ topicId, sessionKey: rec.sessionKey });
  }
  return out;
}

function textResponse(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export default definePluginEntry({
  id: "oc-lane-supervisor",
  name: "OC Lane Supervisor",
  description: "Unified Lane Supervisor (Plugins v2) — consolidates turn energy budgeting, habit economics, soft-landing gating, topic admission control, zero-delta frame collapsing, transient tool rollups, and topic registry recovery.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: LaneSupervisorConfig = (config as LaneSupervisorConfig) ?? {};
    const sessionsPath = cfg.sessionsPath;
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxAgeHours = cfg.maxAgeHours ?? 15;
    const suppressIdle = cfg.suppressIdleHeartbeats ?? true;
    const enablePollDedup = cfg.enablePollDeduplication ?? true;
    const rollupEnabled = cfg.rollupTransientSteps ?? true;
    const laneCapMs = cfg.laneCapMs ?? DEFAULT_LANE_CAP_MS;
    const warnRatio = cfg.warningThresholdRatio ?? DEFAULT_WARN_RATIO;
    const enableWorkerPool = cfg.enableWorkerPool ?? false;

    // Turn Burst Rollup Options
    const rollupOptions: RollupOptions = {
      transientTools: cfg.rollupTransientTools,
      minBurstSize: cfg.rollupMinBurstSize ?? 4,
      tailChars: cfg.rollupTailChars,
    };
    const rollupTrackers = new Map<string, TurnBurstTracker>();

    // Truncation Options
    const truncationOptions: TruncationOptions = {
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
      maxToolResultChars: cfg.maxToolResultChars,
      exemptTools: cfg.exemptTools,
    };

    // Polling & Circuit Breaker States
    let pollDedupState: PollDeduplicationState = createInitialPollDeduplicationState();
    let turnPollState: TurnPollState = createInitialTurnPollState();
    let circuitBreakerState: CircuitBreakerState = createInitialCircuitBreakerState();
    const circuitBreakerConfig: CircuitBreakerConfig = {
      maxConsecutiveIdenticalErrors: cfg.maxConsecutiveIdenticalErrors,
      enableErrorCircuitBreaker: cfg.enableErrorCircuitBreaker,
    };

    // Energy Budgeting & Session Reputation
    const enableEnergyBudget = cfg.enableEnergyBudget ?? true;
    const enableEnergyHeaders = cfg.enableEnergyEnvelopeHeaders ?? false;
    const initialSessionTier: SessionTier = cfg.initialSessionTier ?? "standard";
    const sessionReputations = new Map<string, SessionReputation>();
    const sessionTurnEnergy = new Map<string, TurnEnergyState>();
    const sessionTurnStartTimes = new Map<string, number>();
    const sessionLastToolTimes = new Map<string, number>();

    // In-flight run start tracking for forecaster
    const activeRunStarts = new Map<string, number>();

    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) => writeSessions(data, path ?? sessionsPath);

    // ── Hook: before_dispatch — topic admission & run duration forecast ──
    api.on("before_dispatch", async (event: unknown) => {
      try {
        if (!event || typeof event !== "object") return event;
        const ev = event as Record<string, unknown>;
        const now = Date.now();
        const sessionKey = String(ev.sessionKey ?? "");
        const content = String(ev.content ?? ev.prompt ?? "");
        const topicId = ev.topicId as string | number | undefined;

        // 1. Forecaster classification
        const history = sessionKey ? defaultHistoryStore.read(sessionKey) : null;
        const { prediction } = classifyAndForecast(
          { prompt: content, sessionKey, topicId, history: history ?? undefined },
          { nowMs: now, laneCapMs, warningThresholdRatio: warnRatio },
        );

        if (prediction.exceedsCap || prediction.recommendation !== "proceed_normal") {
          api.logger?.warn?.(`[oc-lane-supervisor] High duration predicted: ${prediction.advice}`);
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] before_dispatch error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_agent_run — idle suppress & turn energy init ──
    api.on("before_agent_run", async (event: unknown, ctx?: unknown) => {
      try {
        turnPollState = createInitialTurnPollState();
        const now = Date.now();
        const ev = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const sessionKey =
          ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
            ? (ctx as { sessionId: string }).sessionId
            : String(ev.sessionKey ?? ev.sessionId ?? "default");

        const runId = String(ev.runId ?? ev.sessionId ?? `run-${now}`);
        activeRunStarts.set(runId, now);

        if (enableEnergyBudget) {
          sessionTurnStartTimes.set(sessionKey, now);
          sessionLastToolTimes.set(sessionKey, now);

          const rep = sessionReputations.get(sessionKey);
          const tier = rep ? rep.tier : initialSessionTier;
          sessionTurnEnergy.set(sessionKey, initTurnEnergy(tier));
        }

        if (!suppressIdle) {
          return { outcome: "pass" };
        }

        const prompt = String(ev.prompt ?? "");
        const trigger = ctx && typeof ctx === "object" && "trigger" in ctx ? String((ctx as { trigger?: unknown }).trigger ?? "") : "";
        const isHeartbeatTrigger = trigger === "heartbeat" || trigger === "cron";
        const hasGuidance = HEARTBEAT_CONTEXT_GUIDANCE_REGEX.test(prompt);
        const hasOkPrompt = HEARTBEAT_OK_PROMPT_REGEX.test(prompt);
        const hasToolPrompt = HEARTBEAT_TOOL_PROMPT_REGEX.test(prompt);
        const isPollMessage = HEARTBEAT_POLL_REGEX.test(prompt.trim());

        if (isHeartbeatTrigger && hasGuidance && hasOkPrompt && !hasToolPrompt && !isPollMessage) {
          api.logger?.info?.(MESSAGES.IDLE_HEARTBEAT_LOG);
          return { outcome: "suppress" };
        }

        return { outcome: "pass" };
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] before_agent_run error: ${String(err)}`);
        return { outcome: "pass" };
      }
    });

    // ── Hook: before_tool_call — circuit breaker & energy soft landing ──
    api.on("before_tool_call", (event: unknown, ctx?: unknown) => {
      try {
        if (!event || typeof event !== "object") return event;
        const ev = event as { toolName?: string; params?: Record<string, unknown> };
        const toolName = ev.toolName ?? "";
        const params = ev.params ?? {};

        const sessionKey =
          ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
            ? (ctx as { sessionId: string }).sessionId
            : "default";

        // 1. Evaluate Circuit Breaker
        const cbVerdict = evaluatePreToolCallCircuitBreaker(circuitBreakerState, toolName, params, circuitBreakerConfig);
        if (cbVerdict.blocked) {
          api.logger?.warn?.(`[oc-lane-supervisor] circuit breaker blocked ${toolName}: ${cbVerdict.error?.message}`);
          return {
            block: true,
            blockReason: cbVerdict.error?.message ?? "Tool call blocked by parameter circuit breaker",
          };
        }

        // 2. Evaluate Turn Energy Budget
        if (enableEnergyBudget) {
          let energyState = sessionTurnEnergy.get(sessionKey);
          if (!energyState) {
            const rep = sessionReputations.get(sessionKey);
            const tier = rep ? rep.tier : initialSessionTier;
            energyState = initTurnEnergy(tier);
            sessionTurnEnergy.set(sessionKey, energyState);
          }

          if (energyState.isGated) {
            const blockReason =
              "🛑 Turn energy budget exhausted. Synthesize your visible reply with findings and next steps immediately.";
            api.logger?.warn?.(`[oc-lane-supervisor] energy budget exhausted for ${sessionKey}, gating ${toolName}`);
            return {
              block: true,
              blockReason,
            };
          }
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] before_tool_call error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: tool_result_persist — truncation, zero-delta compaction & energy drain ──
    api.on("tool_result_persist", (event: unknown, ctx?: unknown) => {
      try {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return event;
        }

        const ev = event as { message: Record<string, unknown>; toolName?: string };
        const toolName = ev.toolName ?? (ev.message?.toolName as string | undefined);

        // 1. Zero-delta poll compaction
        const pollResult = compactZeroDeltaPollMessage(ev.message, toolName);
        let currentMessage = pollResult.changed ? pollResult.message : ev.message;

        // 2. Apply head/tail truncation
        const truncResult = applyToolResultTruncation(currentMessage, toolName, truncationOptions);
        if (truncResult.changed) {
          currentMessage = truncResult.message;
        }

        const sessionKey =
          ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
            ? (ctx as { sessionId: string }).sessionId
            : "default";

        // 3. Deduct turn energy and record habit points
        if (enableEnergyBudget && toolName) {
          let energyState = sessionTurnEnergy.get(sessionKey);
          if (!energyState) {
            const rep = sessionReputations.get(sessionKey);
            const tier = rep ? rep.tier : initialSessionTier;
            energyState = initTurnEnergy(tier);
          }

          const now = Date.now();
          const lastTime = sessionLastToolTimes.get(sessionKey) ?? sessionTurnStartTimes.get(sessionKey) ?? now;
          const durationMs = Math.max(0, now - lastTime);
          sessionLastToolTimes.set(sessionKey, now);

          let payloadBytes = 0;
          try {
            payloadBytes = JSON.stringify(currentMessage).length;
          } catch {
            payloadBytes = 0;
          }

          const isDelegation =
            toolName === "sessions_spawn" ||
            toolName === "task_dispatch" ||
            toolName === "durable_spawn";
          const isPoll = toolName === "process" || toolName === "task_status";
          const isZeroDelta = pollResult.isZeroDelta;
          const isTargetedRead =
            toolName === "read" ||
            toolName === "memory_search" ||
            toolName === "memory_get";

          const nextEnergyState = applyEnergyAction(energyState, {
            toolName,
            durationMs,
            payloadBytes,
            isDelegation,
            isPoll,
            isZeroDelta,
            isTargetedRead,
          });
          sessionTurnEnergy.set(sessionKey, nextEnergyState);

          const header = formatEnergyEnvelopeHeader(nextEnergyState);
          let notice = "";
          if (nextEnergyState.isGated) {
            notice = `\n\n${header}\n🛑 [oc-lane-supervisor] Turn energy budget exhausted. Synthesize visible answer immediately.`;
          } else if (nextEnergyState.advisoryEmitted) {
            notice = `\n\n${header}\n⚡ [oc-lane-supervisor] Energy advisory: wrap up tool execution and begin synthesis.`;
          } else if (enableEnergyHeaders) {
            notice = `\n\n${header}`;
          }

          if (notice) {
            if (Array.isArray(currentMessage.content)) {
              currentMessage = {
                ...currentMessage,
                content: [
                  ...currentMessage.content,
                  { type: "text", text: notice },
                ],
              };
            } else if (typeof currentMessage.content === "string") {
              currentMessage = {
                ...currentMessage,
                content: currentMessage.content + notice,
              };
            }
          }
        }

        // 4. Record transient step for turn rollup
        if (rollupEnabled && toolName) {
          const tracker = rollupTrackers.get(sessionKey) ?? createTurnBurstTracker();
          const { tracker: nextTracker } = recordToolResultForRollup(tracker, toolName, rollupOptions);
          rollupTrackers.set(sessionKey, nextTracker);
        }

        return { message: currentMessage };
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] tool_result_persist error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_message_write — zero-delta poll suppression ──────
    api.on("before_message_write", (event: unknown) => {
      if (!enablePollDedup) return event;
      try {
        if (!event || typeof event !== "object" || !("message" in event)) return event;
        const ev = event as { message: Record<string, unknown> };
        const msg = ev.message;

        if (msg.role !== "toolResult") {
          pollDedupState = createInitialPollDeduplicationState();
          return event;
        }

        const toolName = msg.toolName as string | undefined;
        const suppression = evaluateMessageWriteSuppression(msg, pollDedupState, toolName);
        pollDedupState = suppression.nextState;

        if (suppression.block) {
          api.logger?.debug?.(`[oc-lane-supervisor] suppressed consecutive zero-delta poll frame`);
          return { block: true };
        }
        if (suppression.message) {
          return { message: suppression.message };
        }
        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] before_message_write error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: agent_end — rollup squashing & efficiency score update ──
    api.on("agent_end", async (event: unknown, ctx?: unknown) => {
      try {
        const now = Date.now();
        const ev = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const sessionKey =
          ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
            ? (ctx as { sessionId: string }).sessionId
            : String(ev.sessionKey ?? ev.sessionId ?? "default");

        const runId = String(ev.runId ?? ev.sessionId ?? "");
        const startedAt = activeRunStarts.get(runId);
        if (startedAt) {
          activeRunStarts.delete(runId);
          const durationMs = now - startedAt;
          const hitTimeout = Boolean(ev.timedOut ?? (durationMs >= laneCapMs));
          if (sessionKey) {
            defaultHistoryStore.write(sessionKey, durationMs, hitTimeout, now);
          }
        }

        // Update turn efficiency score and session tier
        if (enableEnergyBudget) {
          const energyState = sessionTurnEnergy.get(sessionKey);
          if (energyState) {
            const turnTes = evaluateTurnEfficiencyScore(energyState);
            const currentRep: SessionReputation = sessionReputations.get(sessionKey) ?? {
              rollingTes: 50,
              tier: initialSessionTier,
              maxSubagentSlots: 3,
              queuePriority: "normal",
            };
            const updatedRep = updateSessionReputation(currentRep, turnTes);
            sessionReputations.set(sessionKey, updatedRep);

            api.logger?.info?.(
              `[oc-lane-supervisor] turn efficiency: TES=${turnTes}, rollingTES=${updatedRep.rollingTes}, tier=${updatedRep.tier.toUpperCase()}, points=+${energyState.habitPoints}P`
            );
          }
        }

        // Squash qualifying bursts if messages array present
        if (rollupEnabled && ev.messages && Array.isArray(ev.messages)) {
          const rolled = rollupTransientSteps(ev.messages as unknown[], rollupOptions);
          return { messages: rolled.entries, report: rolled.report };
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] agent_end error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: after_compaction — strip bloat fields ───────────────────
    api.on("after_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, { bloatFields, maxAgeHours, nowMs: Date.now() });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatCleanupLog(report));
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] after_compaction failed: ${String(err)}`);
      }
    });

    // ── Hook: session_end — purge stale subagents ─────────────────────
    api.on("session_end", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, { bloatFields, maxAgeHours, nowMs: Date.now() });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatPurgeLog(report));
      } catch (err) {
        api.logger?.error?.(`[oc-lane-supervisor] session_end failed: ${String(err)}`);
      }
    });

    // ── Hook: subagent_spawning — concurrency tracking ────────────────
    api.on("subagent_spawning", async (event: unknown) => {
      return event;
    });

    // ── Hook: subagent_ended — concurrency tracking ───────────────────
    api.on("subagent_ended", async (event: unknown) => {
      return event;
    });

    // ── Tool 1: session_health ────────────────────────────────────────
    api.registerTool({
      name: "session_health",
      description: "Check sessions.json health — file size, entry count, subagent count, habit card, and tier.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) return { content: [{ type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND }] };
          const count = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) => k.includes("subagent")).length;
          const size = JSON.stringify(raw).length;

          const defaultRep: SessionReputation = sessionReputations.get("default") ?? {
            rollingTes: 50,
            tier: initialSessionTier,
            maxSubagentSlots: 3,
            queuePriority: "normal",
          };
          const currentEnergy = sessionTurnEnergy.get("default") ?? initTurnEnergy(defaultRep.tier);
          const efficiencyCard = formatHabitTelemetryCard({
            tier: defaultRep.tier,
            rollingTes: defaultRep.rollingTes,
            remainingEnergy: currentEnergy.remainingEnergy,
            initialEnergy: currentEnergy.initialEnergy,
            habitPoints: currentEnergy.habitPoints,
            penalties: currentEnergy.penalties,
            actionsCount: currentEnergy.actionsCount,
            delegationCount: currentEnergy.delegationCount,
            maxSubagentSlots: defaultRep.maxSubagentSlots,
            queuePriority: defaultRep.queuePriority,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: formatHealthReport({
                  entryCount: count,
                  subagentCount,
                  sizeBytes: size,
                  efficiencyCard,
                  reputation: {
                    tier: defaultRep.tier,
                    rollingTes: defaultRep.rollingTes,
                    maxSubagentSlots: defaultRep.maxSubagentSlots,
                    queuePriority: defaultRep.queuePriority,
                  },
                }),
              },
            ],
          };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Health check failed: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 2: session_cleanup ───────────────────────────────────────
    api.registerTool({
      name: "session_cleanup",
      description: "Run session cleanup manually — strip bloat fields and purge stale subagents.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) return { content: [{ type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND }] };
          const { cleaned, report } = cleanupSessions(raw, { bloatFields, maxAgeHours, nowMs: Date.now() });
          writer(cleaned, sessionsPath);
          return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Cleanup failed: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 3: lane_forecast ─────────────────────────────────────────
    api.registerTool({
      name: "lane_forecast",
      description: "Evaluates prompt and command shape to predict execution duration against the 600s lane cap and provides segmentation advice.",
      parameters: Type.Object({
        prompt: Type.Optional(Type.String({ description: "Planned prompt or task description to analyze" })),
        command: Type.Optional(Type.String({ description: "Specific shell command planned" })),
        sessionKey: Type.Optional(Type.String({ description: "Session key for historical cadence lookup" })),
        topicId: Type.Optional(Type.String({ description: "Telegram topic ID if applicable" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const now = Date.now();
          const prompt = typeof params.prompt === "string" ? params.prompt : "";
          const command = typeof params.command === "string" ? params.command : "";
          const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
          const topicId = typeof params.topicId === "string" ? params.topicId : undefined;

          const history = sessionKey ? defaultHistoryStore.read(sessionKey) : null;
          const { prediction, report } = classifyAndForecast(
            { prompt, command, sessionKey, topicId, history: history ?? undefined },
            { nowMs: now, laneCapMs, warningThresholdRatio: warnRatio },
          );

          return { content: [{ type: "text" as const, text: JSON.stringify({ prediction, report }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Forecaster error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 4: topic_audit ───────────────────────────────────────────
    api.registerTool({
      name: "topic_audit",
      description: "Compare Telegram forum topics against session registrations; returns orphaned topics, unregistered sessions, and archival decisions.",
      parameters: Type.Object({
        topics: Type.Any({ description: "Raw forum topics payload ({topics:[...]})" }),
        registrations: Type.Optional(Type.Array(Type.Object({ topicId: Type.Number(), sessionKey: Type.String() }))),
        sessionsPath: Type.Optional(Type.String({ description: "Override path to sessions.json" })),
        health: Type.Optional(Type.Boolean({ description: "Include topic health telemetry (default: true)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const parsed = parseTopics(params.topics);
          const sessionsFile = typeof params.sessionsPath === "string" ? params.sessionsPath : sessionsPath;
          const regList: SessionRegistration[] = params.registrations !== undefined ? asRegistrations(params.registrations) : readRegistrations(sessionsFile);

          const precheck = auditPrecheck(parsed, regList.length);
          if (!precheck.ok) {
            return textResponse({
              refused: true,
              error: precheck.error,
              phantomRisk: precheck.phantomRisk,
            });
          }

          const thresholds = {
            maxIdleDays: Number(cfg.maxIdleDays ?? 14),
            maxMessages: Number(cfg.maxMessages ?? 2000),
          };

          const report: TopicAuditReport = {
            ...detectOrphans(parsed, regList),
            archivalDecisions: parsed.map((t) => decideArchival(t, Date.now(), thresholds)),
          };

          if (params.health !== false) {
            const rawSessions = readRegistry(sessionsFile) ?? {};
            const sizes = readTranscriptSizes(rawSessions, sessionsFile);
            report.health = evaluateTopicsHealth(rawSessions, sizes, Date.now());
          }

          return textResponse(report);
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Topic audit error: ${String(err)}` }] };
        }
      },
    });

    // ── Tool 5: topic_recover ─────────────────────────────────────────
    api.registerTool({
      name: "topic_recover",
      description: "Build the canonical session key and registration plan for an orphaned forum topic. With apply=true, writes into sessions.json.",
      parameters: Type.Object({
        topicId: Type.Number({ description: "Forum topic id" }),
        title: Type.Optional(Type.String()),
        chatId: Type.String({ description: "Telegram chat id" }),
        agentId: Type.String({ description: "Agent to bind" }),
        apply: Type.Optional(Type.Any({ description: "Write registration into registry (idempotent)" })),
        sessionsPath: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const topicId = asTopicId(params.topicId);
          const chatId = typeof params.chatId === "string" ? params.chatId : "";
          const agentId = typeof params.agentId === "string" ? params.agentId : "";
          if (topicId === null || !chatId || !agentId) {
            return textResponse({ error: "invalid input: need numeric topicId, chatId, agentId" });
          }

          const title = typeof params.title === "string" ? params.title : "";
          const plan = buildRecoveryPlan(
            { id: topicId, title, messageCount: 0, lastActiveAt: "", pinned: false },
            chatId,
            agentId,
          );

          if (params.apply === true) {
            const sessionsFile = typeof params.sessionsPath === "string" ? params.sessionsPath : sessionsPath;
            const application: RecoveryApplication = writeRecoveryPlan(plan, sessionsFile);
            return textResponse({ plan, application });
          }

          return textResponse(plan);
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Topic recover error: ${String(err)}` }] };
        }
      },
    });
  },
});
