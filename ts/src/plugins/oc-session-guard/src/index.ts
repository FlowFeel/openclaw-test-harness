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
  initTurnEnergy,
  applyEnergyAction,
  evaluateTurnEfficiencyScore,
  resolveTierFromTes,
  updateSessionReputation,
  formatEnergyEnvelopeHeader,
  formatHabitTelemetryCard,
  type TurnEnergyState,
  type SessionTier,
  type SessionReputation,
} from "../../shared/efficiency-energy-logic.js";
/**
 * OC Session Guard — session bloat and idle admission management plugin.
 *
 * @behavior
 * - Hooks into after_compaction and session_end to strip bloat fields
 *   and purge stale subagent entries from sessions.json.
 * - Hooks into before_agent_run to intercept and suppress idle heartbeat
 *   turns, guaranteeing zero model calls when the instance is idle.
 * - Hooks into tool_result_persist to truncate oversized tool results
 *   (head 800 + tail 800 elision with omission notice) and compact zero-delta poll frames.
 * - Hooks into before_message_write to suppress consecutive identical poll frames.
 *
 * @invariants
 * - No OC core files modified
 * - Pure logic in idle-guard-logic.ts, tool-result-hygiene-logic.ts, poll-hygiene-logic.ts, and session-cleanup.ts
 * - Regexes, messages, and formatters in utils.ts
 * - File I/O in sessions-io.ts (injectable for tests)
 * - Zero auxiliary model calls
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { cleanupSessions } from "../../shared/session-cleanup.js";
import {
  readSessions,
  writeSessions,
  type SessionsReader,
  type SessionsWriter,
} from "./sessions-io.js";
import { evaluateAgentRunAdmission } from "./idle-guard-logic.js";
import {
  applyToolResultTruncation,
  type TruncationOptions,
} from "./tool-result-hygiene-logic.js";
import {
  compactZeroDeltaPollMessage,
  evaluateMessageWriteSuppression,
  createInitialPollDeduplicationState,
  type PollDeduplicationState,
} from "./poll-hygiene-logic.js";
import {
  formatCleanupLog,
  formatPurgeLog,
  formatHealthReport,
  MESSAGES,
} from "./utils.js";
import {
  createTurnBurstTracker,
  recordToolResultForRollup,
  finalizeTurnRollup,
  rollupTransientSteps,
  type RollupOptions,
  type TurnBurstTracker,
} from "./rollup-logic.js";

export interface SessionGuardConfig extends TruncationOptions {
  maxAgeHours?: number;
  stripBloatFields?: boolean;
  bloatFields?: string[];
  sessionsPath?: string;
  suppressIdleHeartbeats?: boolean;
  enablePollDeduplication?: boolean;
  /** T-583: squash large intermediate discovery/inspection bursts into atomic summaries at turn end. */
  rollupTransientSteps?: boolean;
  /** T-583: minimum consecutive transient results before a burst is squashed. */
  rollupMinBurstSize?: number;
  /** T-583: tool names treated as transient discovery/inspection steps. */
  rollupTransientTools?: string[];
  /** T-583: tail characters preserved from the final result of a squashed burst. */
  rollupTailChars?: number;
  /** T-585: Turn-level cumulative polling budget in milliseconds (default: 90000). */
  turnPollBudgetMs?: number;
  enableTurnPollBudget?: boolean;
  /** T-586: Max consecutive identical errors before tripping circuit breaker (default: 2). */
  maxConsecutiveIdenticalErrors?: number;
  enableErrorCircuitBreaker?: boolean;
  /** Phase 2/3: Dynamic energy budgeting & soft landing */
  enableEnergyBudget?: boolean;
  enableEnergyEnvelopeHeaders?: boolean;
  initialSessionTier?: SessionTier;
}

const DEFAULT_BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

export default definePluginEntry({
  id: "oc-session-guard",
  name: "OC Session Guard",
  description:
    "Session bloat, idle admission guard & tool result hygiene — strips bloat fields, purges stale subagents, blocks idle model calls, truncates oversized tool outputs, and collapses poll loops.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: SessionGuardConfig = (config as SessionGuardConfig) ?? {};
    const bloatFields = cfg.bloatFields ?? DEFAULT_BLOAT_FIELDS;
    const maxAgeHours = cfg.maxAgeHours ?? 15;
    const sessionsPath = cfg.sessionsPath;
    const suppressIdle = cfg.suppressIdleHeartbeats ?? true;
    const enablePollDedup = cfg.enablePollDeduplication ?? true;
    const rollupEnabled = cfg.rollupTransientSteps ?? true;
    const rollupOptions: RollupOptions = {
      transientTools: cfg.rollupTransientTools,
      minBurstSize: cfg.rollupMinBurstSize,
      tailChars: cfg.rollupTailChars,
    };

    // T-583: per-session turn burst trackers. During the turn, tool results
    // persist normally (reasoning is never interrupted mid-turn); the
    // agent_end hook finalizes each session's tracker and squashes bursts.
    const rollupTrackers = new Map<string, TurnBurstTracker>();

    const truncationOptions: TruncationOptions = {
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
      maxToolResultChars: cfg.maxToolResultChars,
      exemptTools: cfg.exemptTools,
    };

    let pollDedupState: PollDeduplicationState = createInitialPollDeduplicationState();
    // T-585: Turn-level polling budget state (reset on before_agent_run)
    let turnPollState: TurnPollState = createInitialTurnPollState();
    const pollBudgetConfig: PollBudgetConfig = {
      turnPollBudgetMs: cfg.turnPollBudgetMs,
      enableTurnPollBudget: cfg.enableTurnPollBudget,
    };

    // T-586: Parameter circuit breaker state
    let circuitBreakerState: CircuitBreakerState = createInitialCircuitBreakerState();
    const circuitBreakerConfig: CircuitBreakerConfig = {
      maxConsecutiveIdenticalErrors: cfg.maxConsecutiveIdenticalErrors,
      enableErrorCircuitBreaker: cfg.enableErrorCircuitBreaker,
    };

    // Phase 2/3: Turn Energy & Session Reputation State
    const enableEnergyBudget = cfg.enableEnergyBudget ?? true;
    const enableEnergyHeaders = cfg.enableEnergyEnvelopeHeaders ?? false;
    const initialSessionTier: SessionTier = cfg.initialSessionTier ?? "standard";
    const sessionReputations = new Map<string, SessionReputation>();
    const sessionTurnEnergy = new Map<string, TurnEnergyState>();
    const sessionTurnStartTimes = new Map<string, number>();
    const sessionLastToolTimes = new Map<string, number>();

    const reader: SessionsReader = (path) => readSessions(path ?? sessionsPath);
    const writer: SessionsWriter = (data, path) =>
      writeSessions(data, path ?? sessionsPath);

    // ── Hook: before_tool_call — turn energy budgeting & circuit breaker ──
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
          api.logger?.warn?.(`[oc-session-guard] circuit breaker blocked ${toolName}: ${cbVerdict.error?.message}`);
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
            api.logger?.warn?.(`[oc-session-guard] energy budget exhausted for ${sessionKey}, gating ${toolName}`);
            return {
              block: true,
              blockReason,
            };
          }
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] before_tool_call error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: tool_result_persist — head/tail truncation, poll compaction & energy deduction ──
    api.on("tool_result_persist", (event: unknown, ctx?: unknown) => {
      try {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return event;
        }

        const ev = event as { message: Record<string, unknown>; toolName?: string };
        const toolName = ev.toolName ?? (ev.message?.toolName as string | undefined);

        // 1. First check zero-delta poll compaction
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

        // Phase 2: Deduct turn energy and award habit points
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

          // Phase 3: Cognitive envelope header & advisory in toolResult
          const header = formatEnergyEnvelopeHeader(nextEnergyState);
          let notice = "";
          if (nextEnergyState.isGated) {
            notice = `\n\n${header}\n🛑 [oc-session-guard] Turn energy budget exhausted. Synthesize visible answer immediately.`;
          } else if (nextEnergyState.advisoryEmitted) {
            notice = `\n\n${header}\n⚡ [oc-session-guard] Energy advisory: wrap up tool execution and begin synthesis.`;
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

        // 3. T-583: record the transient step for the turn rollup WITHOUT
        //    modifying the message — results stay intact mid-turn so reasoning
        //    is never interrupted; squashing happens only at agent_end.
        if (rollupEnabled && toolName) {
          const tracker = rollupTrackers.get(sessionKey) ?? createTurnBurstTracker();
          const { tracker: nextTracker } = recordToolResultForRollup(tracker, toolName, rollupOptions);
          rollupTrackers.set(sessionKey, nextTracker);
        }

        return { message: currentMessage };
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] tool_result_persist error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_message_write — zero-delta poll frame suppression ──
    api.on("before_message_write", (event: unknown) => {
      if (!enablePollDedup) {
        return event;
      }
      try {
        if (!event || typeof event !== "object" || !("message" in event)) {
          return event;
        }
        const ev = event as { message: Record<string, unknown> };
        const msg = ev.message;

        // Only process toolResult messages for poll suppression
        if (msg.role !== "toolResult") {
          pollDedupState = createInitialPollDeduplicationState();
          return event;
        }

        const toolName = msg.toolName as string | undefined;
        const suppression = evaluateMessageWriteSuppression(msg, pollDedupState, toolName);
        pollDedupState = suppression.nextState;

        if (suppression.block) {
          api.logger?.debug?.(`[oc-session-guard] suppressed consecutive zero-delta poll frame (count=${pollDedupState.suppressedPollCount})`);
          return { block: true };
        }

        if (suppression.message) {
          return { message: suppression.message };
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] before_message_write error: ${String(err)}`);
        return event;
      }
    });

    // ── Hook: before_agent_run — suppress idle model calls & initialize turn energy ──
    api.on("before_agent_run", async (event: unknown, ctx?: unknown) => {
      turnPollState = createInitialTurnPollState();

      const sessionKey =
        ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
          ? (ctx as { sessionId: string }).sessionId
          : "default";

      if (enableEnergyBudget) {
        const now = Date.now();
        sessionTurnStartTimes.set(sessionKey, now);
        sessionLastToolTimes.set(sessionKey, now);

        const rep = sessionReputations.get(sessionKey);
        const tier = rep ? rep.tier : initialSessionTier;
        sessionTurnEnergy.set(sessionKey, initTurnEnergy(tier));
      }

      if (!suppressIdle) {
        return { outcome: "pass" };
      }
      try {
        const prompt =
          event && typeof event === "object" && "prompt" in event
            ? String((event as { prompt?: unknown }).prompt ?? "")
            : "";
        const trigger =
          ctx && typeof ctx === "object" && "trigger" in ctx
            ? String((ctx as { trigger?: unknown }).trigger ?? "")
            : "";
        const decision = evaluateAgentRunAdmission(prompt, { trigger });
        if (decision.outcome === "block") {
          api.logger?.info?.(MESSAGES.IDLE_HEARTBEAT_LOG);
        }
        return decision;
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.BEFORE_RUN_FAILED_LOG}${String(err)}`);
        return { outcome: "pass" };
      }
    });

    // ── Hook: after_compaction — strip bloat fields ─────────
    api.on("after_compaction", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatCleanupLog(report));
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.CLEANUP_FAILED_LOG}${String(err)}`);
      }
    });

    // ── Hook: session_end — purge stale subagents ───────────
    api.on("session_end", async () => {
      try {
        const raw = reader(sessionsPath);
        if (!raw) return;
        const { cleaned, report } = cleanupSessions(raw, {
          bloatFields,
          maxAgeHours,
          nowMs: Date.now(),
        });
        writer(cleaned, sessionsPath);
        api.logger?.info?.(formatPurgeLog(report));
      } catch (err) {
        api.logger?.error?.(`${MESSAGES.PURGE_FAILED_LOG}${String(err)}`);
      }
    });

    // ── Hook: agent_end — turn-finalization transient-step rollup (T-583) ──
    // Fires when the conversation turn completes. If the event carries a
    // `messages` transcript slice, qualifying bursts of consecutive transient
    // discovery/inspection tool results are squashed into ONE atomic summary
    // entry each and the rolled transcript + report are returned. Otherwise,
    // the per-session burst tracker is finalized and the rollup outcome is
    // logged. Mid-turn results are never touched.
    api.on("agent_end", async (event: unknown, ctx?: unknown) => {
      if (!rollupEnabled) return event;
      try {
        const sessionKey =
          ctx && typeof ctx === "object" && "sessionId" in ctx && typeof (ctx as { sessionId?: unknown }).sessionId === "string"
            ? (ctx as { sessionId: string }).sessionId
            : "default";
        const tracker = rollupTrackers.get(sessionKey) ?? createTurnBurstTracker();
        rollupTrackers.delete(sessionKey);
        const turnStats = finalizeTurnRollup(tracker, rollupOptions);

        const eventRec = (event && typeof event === "object" ? event : null) as Record<string, unknown> | null;
        const messages = eventRec && Array.isArray(eventRec.messages) ? (eventRec.messages as unknown[]) : undefined;

        if (messages) {
          const rolled = rollupTransientSteps(messages, rollupOptions);
          if (rolled.report.changed) {
            api.logger?.info?.(
              `[oc-session-guard] agent_end rollup: ${rolled.report.burstsRolled} burst(s) squashed, ` +
              `${rolled.report.entriesRemoved} entries removed, ` +
              `${rolled.report.charsBefore} → ${rolled.report.charsAfter} chars`
            );
          }
          return { messages: rolled.entries, report: rolled.report };
        }

        if (turnStats.shouldRollup) {
          api.logger?.info?.(
            `[oc-session-guard] agent_end rollup: ${turnStats.qualifyingBurstSizes.length} qualifying burst(s) ` +
            `(sizes: ${turnStats.qualifyingBurstSizes.join(", ")}) of ${turnStats.totalTransient} ` +
            `transient discovery/inspection results this turn`
          );
        }

        // Phase 2: Finalize Turn Efficiency Score and update Session Reputation
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
              `[oc-session-guard] turn efficiency: TES=${turnTes}, rollingTES=${updatedRep.rollingTes}, tier=${updatedRep.tier.toUpperCase()}, points=+${energyState.habitPoints}P`
            );
          }
        }

        return event;
      } catch (err) {
        api.logger?.error?.(`[oc-session-guard] agent_end rollup failed: ${String(err)}`);
        return event;
      }
    });

    // ── Tool: session_health ────────────────────────────────
    api.registerTool({
      name: "session_health",
      description:
        "Check sessions.json health — file size, entry count, subagent count. " +
        "Run before and after compaction to monitor bloat.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) {
            return {
              content: [
                { type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND },
              ],
            };
          }
          const count = Object.keys(raw).length;
          const subagentCount = Object.keys(raw).filter((k) =>
            k.includes("subagent"),
          ).length;
          const size = JSON.stringify(raw).length;

          // Phase 3: Include Habit Telemetry Card in health report
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
          return {
            content: [
              {
                type: "text" as const,
                text: `${MESSAGES.HEALTH_CHECK_FAILED}${String(err)}`,
              },
            ],
          };
        }
      },
    });

    // ── Tool: session_cleanup ────────────────────────────────
    api.registerTool({
      name: "session_cleanup",
      description:
        "Run session cleanup manually — strip bloat fields and purge stale subagents. " +
        "Returns a report of what was cleaned.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const raw = reader(sessionsPath);
          if (!raw) {
            return {
              content: [
                { type: "text" as const, text: MESSAGES.SESSIONS_NOT_FOUND },
              ],
            };
          }
          const { cleaned, report } = cleanupSessions(raw, {
            bloatFields,
            maxAgeHours,
            nowMs: Date.now(),
          });
          writer(cleaned, sessionsPath);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(report, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${MESSAGES.CLEANUP_MANUAL_FAILED}${String(err)}`,
              },
            ],
          };
        }
      },
    });
  },
});
