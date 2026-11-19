/**
 * Compaction & Transcript Sanitization State Slice.
 *
 * @invariants
 * - Owns compaction trigger cooldown timestamp, active M8 file snapshot, and sanitization metrics.
 *
 * @dft
 * - Tested directly via slices/compaction/tests/logic.spec.ts.
 */

import type { CompactionSnapshot } from "../../resume-delta-logic.js";

export interface CompactionSliceConfig {
  autoCompactionEnabled: boolean;
  autoCompactionThresholdMb: number;
  maxTranscriptMb: number;
  watchedPaths: string[];
}

export interface CompactionSliceState {
  readonly lastTriggerMs: number;
  readonly snapshot: CompactionSnapshot | null;
  readonly totalSanitizedLinesRemoved: number;
}

export function createCompactionSliceState(): CompactionSliceState {
  return {
    lastTriggerMs: 0,
    snapshot: null,
    totalSanitizedLinesRemoved: 0,
  };
}
