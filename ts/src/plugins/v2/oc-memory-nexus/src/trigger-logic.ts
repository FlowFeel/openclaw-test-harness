/**
 * Proactive compaction trigger decision logic.
 *
 * @behavior
 * Evaluates transcript byte size and cooldown state to determine whether
 * proactive compaction should be triggered automatically before the session
 * inflates to the platform saturation ceiling (~5MB / 262k tokens).
 *
 * @invariants
 * - Pure: no I/O, no node:* builtins.
 * - Deterministic: all timestamps (nowMs) are injected.
 * - Non-negative thresholds and cooldowns enforced.
 * - Conforms to Axiom 1 (pure-io-separation), Axiom 2 (determinism),
 *   Axiom 4 (dft-docs), and Axiom 6 (check-result).
 *
 * @dft
 * - Pure logic tested with inline objects in trigger-logic.spec.ts.
 * - Exhaustive boundary tests: under threshold, exactly threshold, over threshold,
 *   active cooldown, zero threshold, disabled flag.
 */

export interface CompactionTriggerOptions {
  currentSizeBytes: number;
  maxTranscriptMb: number;
  lastTriggerMs: number;
  nowMs: number;
  cooldownMs?: number;
  enabled?: boolean;
}

export interface TriggerDecision {
  shouldTrigger: boolean;
  currentSizeMb: number;
  thresholdMb: number;
  cooldownRemainingMs: number;
  reason: string;
}

/** Default minimum time between proactive compaction triggers: 2 minutes. */
export const DEFAULT_TRIGGER_COOLDOWN_MS = 120_000;

/** Default size threshold for proactive compaction: 2 MB (well below 5 MB ceiling). */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_MB = 2.0;

/**
 * Pure decision function: determines if proactive compaction should trigger.
 */
export function evaluateCompactionTrigger(
  opts: CompactionTriggerOptions
): TriggerDecision {
  const enabled = opts.enabled ?? true;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_TRIGGER_COOLDOWN_MS;
  const currentSizeMb =
    Math.round((opts.currentSizeBytes / (1024 * 1024)) * 100) / 100;
  const thresholdMb = opts.maxTranscriptMb;

  if (!enabled) {
    return {
      shouldTrigger: false,
      currentSizeMb,
      thresholdMb,
      cooldownRemainingMs: 0,
      reason: "Proactive auto-compaction is disabled in configuration.",
    };
  }

  const elapsedMs = opts.nowMs - opts.lastTriggerMs;
  const cooldownRemainingMs = Math.max(0, cooldownMs - elapsedMs);

  if (cooldownRemainingMs > 0 && opts.lastTriggerMs > 0) {
    return {
      shouldTrigger: false,
      currentSizeMb,
      thresholdMb,
      cooldownRemainingMs,
      reason: `Compaction cooldown active: ${cooldownRemainingMs}ms remaining before next evaluation.`,
    };
  }

  if (currentSizeMb >= thresholdMb) {
    return {
      shouldTrigger: true,
      currentSizeMb,
      thresholdMb,
      cooldownRemainingMs: 0,
      reason: `Transcript size (${currentSizeMb} MB) meets or exceeds threshold (${thresholdMb} MB). Triggering proactive compaction.`,
    };
  }

  return {
    shouldTrigger: false,
    currentSizeMb,
    thresholdMb,
    cooldownRemainingMs: 0,
    reason: `Transcript size (${currentSizeMb} MB) is below threshold (${thresholdMb} MB).`,
  };
}
