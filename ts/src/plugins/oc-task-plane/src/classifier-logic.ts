/**
 * Classifier Logic — pure heuristics engine for long-running task classification.
 *
 * @behavior
 * Inspects command strings and task payloads against known long-runner heuristics
 * and execution history. Identifies tasks likely to breach foreground lane caps
 * (e.g. 630s CommandLaneTimeout) and provides pre-dispatch recommendations.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:child_process, node:path, etc.).
 * - No Date.now() / Math.random() — all time injected via options.nowMs.
 * - Mutating/evaluating functions return a report (CheckResult pattern).
 *
 * @dft
 * - Pure logic tested in classifier-logic.spec.ts with inline data.
 * - Zero fixtures, deterministic.
 */

export interface LongRunnerPattern {
  category: string;
  pattern: RegExp;
  description: string;
  suggestedTimeoutMs: number;
}

export const KNOWN_LONG_RUNNER_PATTERNS: readonly LongRunnerPattern[] = [
  {
    category: "docker",
    pattern: /\bdocker\s+(build|compose\s+(build|up(\s+--build)?))\b/i,
    description: "Docker build or compose build operation",
    suggestedTimeoutMs: 1800000, // 30m
  },
  {
    category: "package-install",
    pattern: /\b(npm\s+(ci|install|rebuild)|yarn(\s+install)?|pnpm\s+install|composer\s+install|cargo\s+build|pip\s+install)\b/i,
    description: "Package manager installation or build step",
    suggestedTimeoutMs: 900000, // 15m
  },
  {
    category: "test-suite",
    pattern: /\b(npm\s+test|vitest(\s+run)?|jest|pytest|cargo\s+test|go\s+test)\b/i,
    description: "Full test suite execution",
    suggestedTimeoutMs: 900000, // 15m
  },
  {
    category: "data-media",
    pattern: /\b(rsync|ffmpeg|tar\s+-[a-z]*c[a-z]*f|wget|curl\s+-[a-z]*O)\b/i,
    description: "Data transfer, compression, or media transcoding",
    suggestedTimeoutMs: 1800000, // 30m
  },
  {
    category: "machine-learning",
    pattern: /\bpython\d?\s+.*(train|fine_tune|eval|embed).*\.py\b/i,
    description: "Machine learning model training or inference loop",
    suggestedTimeoutMs: 3600000, // 60m
  },
];

export const FOREGROUND_CAP_MS = 630000; // 630s lane timeout

export interface CommandHistoryRecord {
  commandPrefix: string;
  hitTimeoutCap: boolean;
  durationMs: number;
  recordedAt: number;
}

export interface ClassificationResult {
  isLongRunner: boolean;
  category?: string;
  matchedPattern?: string;
  suggestedTimeoutMs?: number;
  advice: string;
  recommendation: "task_dispatch" | "foreground";
}

export interface ClassifierReport {
  command: string;
  isLongRunner: boolean;
  reason: string;
  analyzedAt: number;
  historyMatched: boolean;
}

/**
 * Classifies a command string to determine if it is likely to exceed foreground caps.
 */
export function classifyCommand(
  command: string,
  history: readonly CommandHistoryRecord[] = [],
  options: { nowMs: number }
): { result: ClassificationResult; report: ClassifierReport } {
  const trimmed = command.trim();

  // 1. Check history for previous cap hits on same command prefix
  const historyMatch = history.find(
    (h) => h.hitTimeoutCap && trimmed.startsWith(h.commandPrefix)
  );

  if (historyMatch) {
    const result: ClassificationResult = {
      isLongRunner: true,
      category: "history-recall",
      suggestedTimeoutMs: Math.max(historyMatch.durationMs * 1.5, 900000),
      advice: `Command previously hit the ${FOREGROUND_CAP_MS / 1000}s foreground cap. Dispatch via task_dispatch to avoid CommandLaneTimeout.`,
      recommendation: "task_dispatch",
    };
    const report: ClassifierReport = {
      command: trimmed,
      isLongRunner: true,
      reason: `History record: matched previous cap hit on '${historyMatch.commandPrefix}'`,
      analyzedAt: options.nowMs,
      historyMatched: true,
    };
    return { result, report };
  }

  // 2. Check known heuristic patterns
  for (const item of KNOWN_LONG_RUNNER_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      const result: ClassificationResult = {
        isLongRunner: true,
        category: item.category,
        matchedPattern: item.description,
        suggestedTimeoutMs: item.suggestedTimeoutMs,
        advice: `Command matches ${item.description}. This is likely to exceed the ${FOREGROUND_CAP_MS / 1000}s foreground lane cap — dispatch via task_dispatch.`,
        recommendation: "task_dispatch",
      };
      const report: ClassifierReport = {
        command: trimmed,
        isLongRunner: true,
        reason: `Matched heuristic pattern: ${item.description}`,
        analyzedAt: options.nowMs,
        historyMatched: false,
      };
      return { result, report };
    }
  }

  // 3. Normal foreground runner
  const result: ClassificationResult = {
    isLongRunner: false,
    advice: "Command does not match long-runner heuristics. Foreground execution is safe.",
    recommendation: "foreground",
  };
  const report: ClassifierReport = {
    command: trimmed,
    isLongRunner: false,
    reason: "No heuristic or history triggers matched",
    analyzedAt: options.nowMs,
    historyMatched: false,
  };

  return { result, report };
}
