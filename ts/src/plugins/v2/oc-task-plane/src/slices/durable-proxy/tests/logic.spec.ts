/**
 * Tier 1 Unit Spec: oc-task-plane / durable-proxy slice.
 *
 * @dft Pure unit tests — verifies durable sidecar response interpretation and transport error counting.
 */

import { describe, it, expect } from "vitest";
import { createDurableProxyState } from "../state.js";
import { recordDurableOutcome } from "../logic.js";

describe("oc-task-plane / slices/durable-proxy (Tier 1 Unit)", () => {
  it("tracks HTTP responses and transport failures immutably", () => {
    let state = createDurableProxyState();
    const ok = recordDurableOutcome(state, { status: 200, body: { task_id: "j1", state: "running" } });
    state = ok.nextState;
    expect(state.totalRequests).toBe(1);
    expect(state.transportErrors).toBe(0);
    expect(ok.text).toContain("pending");

    const err = recordDurableOutcome(state, undefined, new Error("ECONNREFUSED"));
    state = err.nextState;
    expect(state.totalRequests).toBe(2);
    expect(state.transportErrors).toBe(1);
  });
});

