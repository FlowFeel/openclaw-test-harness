/**
 * OcLaneForecaster — plugin entry point (wiring layer).
 *
 * @behavior
 * Wires pre-dispatch run duration prediction, shape classification (work-loop,
 * slow-ops), and lane-cap early warnings to OpenClaw lifecycle hooks and tools.
 * Hooks into before_dispatch and before_agent_run to classify upcoming work,
 * emit lane event telemetry, and advise on early checkpointing or segmenting.
 * Hooks into agent_end to record run duration telemetry for moving averages.
 *
 * @invariants
 * - No direct node:fs imports — all I/O delegates to forecaster-io.ts.
 * - All forecasting heuristics delegate to forecaster-logic.ts.
 * - All hooks registered via api.on() (never api.registerHook()).
 * - Tool names match contracts.tools in openclaw.plugin.json.
 *
 * @dft
 * - Tested with in-memory Protocol doubles and synthetic replay suites.
 * - Conforms to all six DFT axioms.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import {
  classifyAndForecast,
  formatLaneTelemetry,
  DEFAULT_LANE_CAP_MS,
  DEFAULT_WARN_RATIO,
  type ForecastInput,
} from "./forecaster-logic.js";
import {
  defaultHistoryStore,
  type HistoryReader,
  type HistoryWriter,
} from "./forecaster-io.js";

export interface OcLaneForecasterConfig {
  laneCapMs?: number;
  warningThresholdRatio?: number;
  enableTelemetry?: boolean;
}

export interface ForecasterIoDependencies {
  historyReader?: HistoryReader;
  historyWriter?: HistoryWriter;
  now?: () => number;
}

/** Factory to create the plugin definition with optional test dependencies. */
export function createLaneForecasterPlugin(deps: ForecasterIoDependencies = {}) {
  const historyReader = deps.historyReader ?? defaultHistoryStore.read;
  const historyWriter = deps.historyWriter ?? defaultHistoryStore.write;
  const getNow = deps.now ?? (() => Date.now());

  // In-flight run start times keyed by runId or sessionKey
  const activeRunStarts = new Map<string, number>();

  return definePluginEntry({
    id: "oc-lane-forecaster",
    name: "OcLaneForecaster",
    description: "Pre-dispatch run-duration prediction, shape classification (work-loop, slow ops), lane cap early warnings, and lane event telemetry",
    register(api: PluginApi, config?: Record<string, unknown>) {
      const cfg = (config as OcLaneForecasterConfig) ?? {};
      const laneCapMs = cfg.laneCapMs ?? DEFAULT_LANE_CAP_MS;
      const warnRatio = cfg.warningThresholdRatio ?? DEFAULT_WARN_RATIO;
      const enableTelemetry = cfg.enableTelemetry ?? true;

      // ── Hook: before_dispatch ──────────────────────────────────────
      api.on("before_dispatch", async (event) => {
        try {
          const now = getNow();
          const sessionKey = String(event.sessionKey ?? "");
          const content = String(event.content ?? event.prompt ?? "");
          const topicId = event.topicId as string | number | undefined;

          const history = sessionKey ? historyReader(sessionKey) : null;
          const { prediction, report } = classifyAndForecast(
            {
              prompt: content,
              sessionKey,
              topicId,
              history: history ?? undefined,
            },
            {
              nowMs: now,
              laneCapMs,
              warningThresholdRatio: warnRatio,
            }
          );

          if (enableTelemetry) {
            const telemetry = formatLaneTelemetry({
              laneId: String(event.laneId ?? "embedded-run"),
              topicId,
              predictedDurationMs: prediction.predictedDurationMs,
              exceedsCap: prediction.exceedsCap,
              shape: prediction.shape,
            });
            api.logger?.info?.(`[oc-lane-forecaster] ${telemetry}`);
          }

          if (prediction.exceedsCap || prediction.recommendation !== "proceed_normal") {
            api.logger?.warn?.(
              `[oc-lane-forecaster] High duration predicted: ${prediction.advice}`
            );
          }

          return {
            handled: false,
            forecast: prediction,
            report,
          };
        } catch (err) {
          api.logger?.error?.(`[oc-lane-forecaster] before_dispatch failed: ${String(err)}`);
        }
      });

      // ── Hook: before_agent_run ─────────────────────────────────────
      api.on("before_agent_run", async (event) => {
        try {
          const now = getNow();
          const runId = String(event.runId ?? event.sessionId ?? `run-${now}`);
          activeRunStarts.set(runId, now);

          const sessionKey = String(event.sessionKey ?? event.sessionId ?? "");
          const prompt = String(event.prompt ?? "");
          const history = sessionKey ? historyReader(sessionKey) : null;

          const { prediction } = classifyAndForecast(
            {
              prompt,
              sessionKey,
              history: history ?? undefined,
            },
            {
              nowMs: now,
              laneCapMs,
              warningThresholdRatio: warnRatio,
            }
          );

          if (prediction.exceedsCap) {
            api.logger?.warn?.(
              `[oc-lane-forecaster] Run ${runId} likely to breach lane cap (${Math.round(prediction.predictedDurationMs / 1000)}s > ${Math.round(laneCapMs / 1000)}s): ${prediction.advice}`
            );
          }
        } catch (err) {
          api.logger?.error?.(`[oc-lane-forecaster] before_agent_run failed: ${String(err)}`);
        }
      });

      // ── Hook: agent_end ────────────────────────────────────────────
      api.on("agent_end", async (event) => {
        try {
          const now = getNow();
          const runId = String(event.runId ?? event.sessionId ?? "");
          const sessionKey = String(event.sessionKey ?? event.sessionId ?? "");
          const startedAt = activeRunStarts.get(runId);
          if (startedAt) {
            activeRunStarts.delete(runId);
            const durationMs = now - startedAt;
            const hitTimeout = Boolean(event.timedOut ?? (durationMs >= laneCapMs));
            if (sessionKey) {
              historyWriter(sessionKey, durationMs, hitTimeout, now);
            }
          }
        } catch (err) {
          api.logger?.error?.(`[oc-lane-forecaster] agent_end failed: ${String(err)}`);
        }
      });

      // ── Tool: lane_forecast ────────────────────────────────────────
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
            const now = getNow();
            const prompt = typeof params.prompt === "string" ? params.prompt : "";
            const command = typeof params.command === "string" ? params.command : "";
            const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
            const topicId = typeof params.topicId === "string" ? params.topicId : undefined;

            const history = sessionKey ? historyReader(sessionKey) : null;
            const { prediction, report } = classifyAndForecast(
              {
                prompt,
                command,
                sessionKey,
                topicId,
                history: history ?? undefined,
              },
              {
                nowMs: now,
                laneCapMs,
                warningThresholdRatio: warnRatio,
              }
            );

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ok: true,
                      prediction,
                      report,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `lane_forecast failed: ${String(err)}` }],
            };
          }
        },
      });
    },
  });
}

export default createLaneForecasterPlugin();
