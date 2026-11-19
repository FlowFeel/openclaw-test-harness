/**
 * CPU Sidecar State Slice — owns sidecar port, lifecycle status, and offload call counters.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to recall or compaction slices.
 *
 * @dft
 * - Tested directly via slices/cpu-sidecar/tests/logic.spec.ts.
 */

export interface CpuSidecarState {
  readonly port: number;
  readonly active: boolean;
  readonly totalExecCalls: number;
  readonly failedExecCalls: number;
}

export function createCpuSidecarState(port = 18900): CpuSidecarState {
  return { port, active: false, totalExecCalls: 0, failedExecCalls: 0 };
}
