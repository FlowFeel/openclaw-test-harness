/**
 * Tier 1 Unit Spec: oc-memory-nexus / cpu-sidecar slice.
 *
 * @dft Pure unit tests — zero HTTP/process I/O.
 */

import { describe, it, expect } from "vitest";
import { createCpuSidecarState } from "../state.js";
import { transitionSidecarActive, recordSidecarExecOutcome } from "../logic.js";

describe("oc-memory-nexus / slices/cpu-sidecar (Tier 1 Unit)", () => {
  it("tracks lifecycle transitions and exec call counters immutably", () => {
    let state = createCpuSidecarState(18900);
    const started = transitionSidecarActive(state, true);
    state = started.nextState;
    expect(started.changed).toBe(true);
    expect(state.active).toBe(true);

    state = recordSidecarExecOutcome(state, true).nextState;
    state = recordSidecarExecOutcome(state, false).nextState;
    expect(state.totalExecCalls).toBe(2);
    expect(state.failedExecCalls).toBe(1);
  });
});

