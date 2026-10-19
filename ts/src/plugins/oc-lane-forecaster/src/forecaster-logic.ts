/**
 * OcLaneForecaster — pure logic seam for pre-dispatch run duration forecasting.
 *
 * @behavior
 * Predicts run execution duration at dispatch time by classifying run shapes,
 * detecting known slow-op signatures (test suites, probe loops, vision attachments,
 * serial work loops), weighting recent per-run duration history, and evaluating
 * tool-call cadence against the embedded-run lane cap (default: 600s).
 *
 * @invariants
 * - Pure logic: same inputs → same forecast prediction and report.
 * - No I/O imports (no node:fs, node:child_process, node:os).
 * - Deterministic: all timestamps injected via options.nowMs (no Date.now()).
 * - CheckResult pattern: returns { prediction, report } on evaluation.
 *
 * @dft
 * - Tested with inline synthetic data and historical replay datasets.
 * - Zero external fixtures, sub-millisecond execution.
 */

import {
  WORK_LOOP_REGEX,
  TEST_SUITE_FORECAST_REGEX,
  PROBE_LOOP_REGEX,
  VISION_MEDIA_REGEX,
  DEEP_REFACTOR_REGEX,
  INTENT_DIAGNOSE_REGEX,
  INTENT_FIX_REGEX,
  INTENT_TEST_REGEX,
  INTENT_SHIP_REGEX,
} from "../../shared/regex-library.ts";

export const DEFAULT_LANE_CAP_MS = 600000; // 600s embedded-run lane cap
export const DEFAULT_WARN_RATIO = 0.85; // Warn when predicted >= 85% of cap (510s)

export interface SlowOpSignature {
  id: string;
  label: string;
  pattern: Readonly<RegExp>;
  addedDurationMs: number;
  shape: string;
}

export const SLOW_OP_SIGNATURES: readonly SlowOpSignature[] = [
  {
    id: "work-loop",
    label: "Work-loop session (diagnose -> fix -> test -> ship)",
    pattern: WORK_LOOP_REGEX,
    addedDurationMs: 680000, // 11.3 min serial work loop
    shape: "work-loop",
  },
  {
    id: "test-suite",
    label: "Full test suite execution",
    pattern: TEST_SUITE_FORECAST_REGEX,
    addedDurationMs: 650000, // 10.8 min full regression suite
    shape: "test-suite",
  },
  {
    id: "probe-loop",
    label: "HTTP probe / poll loop",
    pattern: PROBE_LOOP_REGEX,
    addedDurationMs: 630000, // 10.5 min unbounded polling loop
    shape: "probe-loop",
  },
  {
    id: "vision-media",
    label: "Vision / multimodal media processing",
    pattern: VISION_MEDIA_REGEX,
    addedDurationMs: 620000, // 10.3 min media processing
    shape: "vision-media",
  },
  {
    id: "deep-refactor",
    label: "Deep multi-component refactoring",
    pattern: DEEP_REFACTOR_REGEX,
    addedDurationMs: 660000, // 11 min multi-file refactoring
    shape: "deep-refactor",
  },
];

export interface SessionRunHistory {
  recentDurationsMs?: readonly number[];
  timeoutsEncountered?: number;
  lastRunDurationMs?: number;
}

export interface ForecastInput {
  prompt?: string;
  command?: string;
  sessionKey?: string;
  topicId?: string | number;
  history?: SessionRunHistory;
  toolCadenceEstimate?: {
    estimatedToolCalls?: number;
    avgLatencyPerCallMs?: number;
  };
}

export interface ForecastOptions {
  nowMs: number;
  laneCapMs?: number;
  warningThresholdRatio?: number;
}

export type ForecastRecommendation =
  | "warn_checkpoint_early"
  | "suggest_segmented_dispatch"
  | "proceed_normal";

export interface ForecastPrediction {
  predictedDurationMs: number;
  laneCapMs: number;
  exceedsCap: boolean;
  confidence: number;
  shape: string;
  matchedSignatures: string[];
  advice: string;
  recommendation: ForecastRecommendation;
  suggestedSegments?: string[];
}

export interface ForecastReport {
  sessionKey?: string;
  topicId?: string;
  evaluatedAt: number;
  predictedDurationMs: number;
  laneCapMs: number;
  exceedsCap: boolean;
  shape: string;
  recommendation: ForecastRecommendation;
  matchedSignatures: string[];
}

/**
 * Pure evaluation function that classifies run shape and forecasts execution duration.
 */
export function classifyAndForecast(
  input: ForecastInput,
  options: ForecastOptions
): { prediction: ForecastPrediction; report: ForecastReport } {
  const laneCapMs = options.laneCapMs ?? DEFAULT_LANE_CAP_MS;
  const warnRatio = options.warningThresholdRatio ?? DEFAULT_WARN_RATIO;
  const warnThresholdMs = laneCapMs * warnRatio;

  const content = `${input.prompt || ""} ${input.command || ""}`.trim();
  const matchedSignatures: string[] = [];
  let primaryShape = "quick-query";
  let maxAddedDuration = 0;
  let cumulativeAddedDuration = 0;

  // 1. Check signatures against content
  for (const sig of SLOW_OP_SIGNATURES) {
    if (sig.pattern.test(content)) {
      matchedSignatures.push(sig.id);
      cumulativeAddedDuration += sig.addedDurationMs;
      if (sig.addedDurationMs > maxAddedDuration) {
        maxAddedDuration = sig.addedDurationMs;
        primaryShape = sig.shape;
      }
    }
  }

  // Work-loop special detection: prompt mentioning diagnose, fix, test, and ship separately
  const hasDiagnose = INTENT_DIAGNOSE_REGEX.test(content);
  const hasFix = INTENT_FIX_REGEX.test(content);
  const hasTest = INTENT_TEST_REGEX.test(content);
  const hasShip = INTENT_SHIP_REGEX.test(content);

  if (hasDiagnose && hasFix && hasTest && hasShip && !matchedSignatures.includes("work-loop")) {
    matchedSignatures.push("work-loop");
    cumulativeAddedDuration += 680000;
    primaryShape = "work-loop";
  }

  // 2. Base estimation
  let baseEstimateMs = 15000; // default 15s for quick single-turn queries
  if (matchedSignatures.length > 0) {
    // If multiple slow ops match (e.g. work-loop + test-suite), cap cumulative addition
    baseEstimateMs = Math.max(maxAddedDuration, Math.min(cumulativeAddedDuration, 850000));
  }

  // 3. Tool cadence incorporation
  if (input.toolCadenceEstimate) {
    const count = input.toolCadenceEstimate.estimatedToolCalls ?? 0;
    const latency = input.toolCadenceEstimate.avgLatencyPerCallMs ?? 35000;
    const toolTime = count * latency;
    if (toolTime > baseEstimateMs) {
      baseEstimateMs = toolTime;
    }
  }

  // 4. Session history incorporation
  let historyInfluenced = false;
  if (input.history) {
    const recent = input.history.recentDurationsMs ?? [];
    const timeouts = input.history.timeoutsEncountered ?? 0;

    if (recent.length > 0) {
      const sum = recent.reduce((a, b) => a + b, 0);
      const avgRecent = sum / recent.length;

      // If session historically averages over 500s or encountered timeouts, weight up
      if (avgRecent >= 480000 || timeouts > 0) {
        historyInfluenced = true;
        matchedSignatures.push("history-timeout-recurrence");
        const historicalFloor = timeouts > 0 ? Math.max(avgRecent, 620000) : avgRecent;
        baseEstimateMs = Math.max(baseEstimateMs, historicalFloor);
        if (primaryShape === "quick-query") {
          primaryShape = "session-recurrent-slow";
        }
      }
    } else {
      if (timeouts > 0) {
        historyInfluenced = true;
        matchedSignatures.push("history-prior-timeouts");
        baseEstimateMs = Math.max(baseEstimateMs, 620000);
        if (primaryShape === "quick-query") {
          primaryShape = "session-recurrent-slow";
        }
      }
    }
  }

  const predictedDurationMs = Math.round(baseEstimateMs);
  const exceedsCap = predictedDurationMs >= laneCapMs;
  const isNearCap = predictedDurationMs >= warnThresholdMs;

  // 5. Confidence calculation
  const confidence = (() => {
    switch (true) {
      case matchedSignatures.includes("work-loop"):
        return 0.92;
      case historyInfluenced && matchedSignatures.length > 1:
        return 0.95;
      case matchedSignatures.length > 0:
        return 0.82;
      default:
        return 0.70;
    }
  })();

  // 6. Formulate advice & recommendations
  let recommendation: ForecastRecommendation = "proceed_normal";
  let advice = "Execution predicted within normal lane capacity.";
  let suggestedSegments: string[] | undefined;

  if (exceedsCap || isNearCap) {
    const predSec = Math.round(predictedDurationMs / 1000);
    const capSec = Math.round(laneCapMs / 1000);

    if (primaryShape === "work-loop") {
      recommendation = "suggest_segmented_dispatch";
      advice = `This work-loop shape historically exceeds the ${capSec}s lane cap (predicted: ${predSec}s) — split into checkpointed segments.`;
      suggestedSegments = [
        "1. Diagnose root cause & draft code fix -> checkpoint commit",
        "2. Run test suites & verify behavior -> checkpoint commit",
        "3. Push branch, open PR & generate shipped summary",
      ];
    } else {
      recommendation = "warn_checkpoint_early";
      advice = `This shape historically exceeds the ${capSec}s lane cap (predicted: ${predSec}s) — checkpoint early.`;
    }
  }

  const prediction: ForecastPrediction = {
    predictedDurationMs,
    laneCapMs,
    exceedsCap,
    confidence,
    shape: primaryShape,
    matchedSignatures,
    advice,
    recommendation,
    suggestedSegments,
  };

  const report: ForecastReport = {
    sessionKey: input.sessionKey,
    topicId: input.topicId ? String(input.topicId) : undefined,
    evaluatedAt: options.nowMs,
    predictedDurationMs,
    laneCapMs,
    exceedsCap,
    shape: primaryShape,
    recommendation,
    matchedSignatures,
  };

  return { prediction, report };
}

/**
 * Formats structured telemetry for the gateway's lane event channel.
 */
export function formatLaneTelemetry(params: {
  laneId?: string;
  topicId?: string | number;
  predictedDurationMs: number;
  exceedsCap: boolean;
  shape: string;
}): string {
  const lane = params.laneId || "embedded-run";
  const topic = params.topicId !== undefined ? `topic:${params.topicId}` : "unknown";
  return `lane forecast: lane=${lane} ${topic} predictedDurationMs=${params.predictedDurationMs} exceedsCap=${params.exceedsCap} shape=${params.shape}`;
}
