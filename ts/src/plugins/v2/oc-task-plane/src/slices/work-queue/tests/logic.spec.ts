/**
 * Tier 1 Unit Spec: oc-task-plane / work-queue slice.
 *
 * @dft Pure unit tests — verifies batch scheduling, status projection, and result merging.
 */

import { describe, it, expect } from "vitest";
import { createWorkQueueSliceState } from "../state.js";
import { enqueueWorkBatch, projectWorkQueueStatus, mergeWorkOutputs } from "../logic.js";

describe("oc-task-plane / slices/work-queue (Tier 1 Unit)", () => {
  it("enqueues tasks up to concurrency cap and reports status", () => {
    const state = createWorkQueueSliceState();
    const res = enqueueWorkBatch(
      state,
      { maxConcurrentSubagents: 2 },
      [
        { id: "t1", prompt: "a", priority: "normal" },
        { id: "t2", prompt: "b", priority: "normal" },
        { id: "t3", prompt: "c", priority: "normal" },
      ],
      1000,
    );
    expect(res.queued).toBe(3);
    expect(res.dispatched).toBe(2);

    const status = projectWorkQueueStatus(res.nextState);
    expect(status.total).toBe(3);
    expect(mergeWorkOutputs([])).toBeDefined();
  });
});
