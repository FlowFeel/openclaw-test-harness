/**
 * Recall Registry State Slice — owns NoteRegistry and RecallTelemetryState.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to compaction or sidecar slices.
 *
 * @dft
 * - Tested directly via slices/recall-registry/tests/logic.spec.ts.
 */

import {
  createRegistry,
  createInitialTelemetry,
  type NoteRegistry,
  type RecallTelemetryState,
} from "../../memory-recall-logic.js";

export interface RecallRegistrySliceState {
  readonly registry: NoteRegistry;
  readonly telemetry: RecallTelemetryState;
  readonly lastScanCount: number;
  readonly lastCandidateCount: number;
}

export function createRecallRegistryState(): RecallRegistrySliceState {
  return {
    registry: createRegistry([]),
    telemetry: createInitialTelemetry(),
    lastScanCount: 0,
    lastCandidateCount: 0,
  };
}
