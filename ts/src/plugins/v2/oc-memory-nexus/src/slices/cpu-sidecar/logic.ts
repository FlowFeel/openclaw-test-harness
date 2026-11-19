/**
 * CPU Sidecar Pure Transition Algebra — lifecycle and offload call accounting.
 *
 * @invariants
 * - Pure logic: zero HTTP/process I/O, returns immutable CpuSidecarState snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/cpu-sidecar/tests/logic.spec.ts.
 */

import type { CpuSidecarState } from "./state.js";

export function transitionSidecarActive(
  state: CpuSidecarState,
  active: boolean,
): { nextState: CpuSidecarState; changed: boolean } {
  return {
    changed: state.active !== active,
    nextState: { ...state, active },
  };
}

export function recordSidecarExecOutcome(
  state: CpuSidecarState,
  ok: boolean,
): { nextState: CpuSidecarState } {
  return {
    nextState: {
      ...state,
      totalExecCalls: state.totalExecCalls + 1,
      failedExecCalls: ok ? state.failedExecCalls : state.failedExecCalls + 1,
    },
  };
}

