/**
 * Compaction & Sanitization Pure Transition Algebra — real trigger evaluation,
 * M8 resume delta computation, and idempotent transcript sanitization transitions.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns CheckResult containers (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/compaction/tests/logic.spec.ts.
 */

import { evaluateCompactionTrigger, type TriggerDecision } from "../../trigger-logic.js";
import {
  createCompactionSnapshot,
  computeFileDeltas,
  type FileDeltaReport,
} from "../../resume-delta-logic.js";
import {
  sanitizeTranscriptLines,
  type SanitizeReport,
} from "../../transcript-sanitizer-logic.js";
import type { CompactionSliceConfig, CompactionSliceState } from "./state.js";

export function evaluateCompactionCheck(
  state: CompactionSliceState,
  config: CompactionSliceConfig,
  currentSizeBytes: number,
  nowMs: number,
): { nextState: CompactionSliceState; decision: TriggerDecision } {
  const decision = evaluateCompactionTrigger({
    currentSizeBytes,
    maxTranscriptMb: config.autoCompactionThresholdMb,
    lastTriggerMs: state.lastTriggerMs,
    nowMs,
    enabled: config.autoCompactionEnabled,
  });

  const nextTriggerMs = decision.shouldTrigger ? nowMs : state.lastTriggerMs;
  return {
    decision,
    nextState: { ...state, lastTriggerMs: nextTriggerMs },
  };
}

export function recordCompactionCheckpoint(
  state: CompactionSliceState,
  files: Record<string, number>,
  nowMs: number,
  checkpointId?: string,
): { nextState: CompactionSliceState; checkpointId: string } {
  const snapshot = createCompactionSnapshot(checkpointId ?? `ckpt-${nowMs}`, nowMs, files);
  return {
    checkpointId: snapshot.checkpointId,
    nextState: { ...state, snapshot },
  };
}

export function evaluateResumeDelta(
  state: CompactionSliceState,
  currentFiles: Record<string, number>,
  nowMs: number,
): { nextState: CompactionSliceState; report: FileDeltaReport } {
  const baseline = state.snapshot ?? createCompactionSnapshot("ckpt-init", nowMs, currentFiles);
  const report = computeFileDeltas(baseline, currentFiles, nowMs);
  return {
    report,
    nextState: state.snapshot ? state : { ...state, snapshot: baseline },
  };
}

export function runTranscriptSanitization(
  state: CompactionSliceState,
  lines: string[],
  dryRun: boolean,
): {
  nextState: CompactionSliceState;
  outputLines: string[];
  report: SanitizeReport;
  mutated: boolean;
  linesRemoved: number;
  bytesSaved: number;
} {
  const { sanitizedLines: outputLines, report } = sanitizeTranscriptLines(lines);
  const linesRemoved = Math.max(0, report.originalEntries - report.sanitizedEntries);
  const bytesSaved = Math.max(0, report.originalBytes - report.sanitizedBytes);
  const mutated = linesRemoved > 0 || bytesSaved > 0;
  const addedRemoved = dryRun ? 0 : linesRemoved;
  return {
    outputLines,
    report,
    mutated,
    linesRemoved,
    bytesSaved,
    nextState: {
      ...state,
      totalSanitizedLinesRemoved: state.totalSanitizedLinesRemoved + addedRemoved,
    },
  };
}
