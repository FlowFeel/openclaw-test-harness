/**
 * Compaction & Transcript Sanitization State Slice.
 *
 * @invariants
 * - Owns compaction trigger cooldown timestamp, active M8 file snapshot, sanitization metrics,
 *   and off-loop durable distillation task dispatch specs (Pillar 2).
 *
 * @dft
 * - Tested directly via slices/compaction/tests/logic.spec.ts.
 */

import type { CompactionSnapshot } from "../../resume-delta-logic.js";

export interface MemoryDistillTaskParams {
  session_key: string;
  topic_id?: number;
  target_dir: string;
  target_file?: string;
  transcript_tail?: string;
}

export interface MemoryDistillTaskSpec {
  task_name: "memory_distill";
  params: MemoryDistillTaskParams;
}

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
  readonly lastDistillationTask: MemoryDistillTaskSpec | null;
  readonly emittedDistillationCount: number;
}

export function createCompactionSliceState(): CompactionSliceState {
  return {
    lastTriggerMs: 0,
    snapshot: null,
    totalSanitizedLinesRemoved: 0,
    lastDistillationTask: null,
    emittedDistillationCount: 0,
  };
}
