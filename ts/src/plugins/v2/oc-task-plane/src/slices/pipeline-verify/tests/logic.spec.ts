/**
 * Tier 1 Unit Spec: oc-task-plane / pipeline-verify slice.
 *
 * @dft Pure unit tests — verifies staging revision SHA comparison and pipeline validation.
 */

import { describe, it, expect } from "vitest";
import { createPipelineVerifyState } from "../state.js";
import { verifyStagingPayload, validateAndCountPipeline } from "../logic.js";

describe("oc-task-plane / slices/pipeline-verify (Tier 1 Unit)", () => {
  it("verifies live vs stale staging SHA payloads", () => {
    let state = createPipelineVerifyState();
    const sha = "a1b2c3d4e5f6789012345678901234567890abcd";
    const ok = verifyStagingPayload(
      state,
      { ok: true, status: 200, payload: { sha } },
      sha,
    );
    state = ok.nextState;
    expect(ok.verdict.verified).toBe(true);
    expect(ok.verdict.status).toBe("live");
    expect(state.verificationsRun).toBe(1);

    const stale = verifyStagingPayload(
      state,
      { ok: true, status: 200, payload: { sha: "0000000" } },
      sha,
    );
    expect(stale.verdict.verified).toBe(false);
    expect(stale.verdict.status).toBe("stale_image_running");
  });

  it("validates pipeline specs and increments run counter", () => {
    const state = createPipelineVerifyState();
    const bad = validateAndCountPipeline(state, { mode: "fail-fast", steps: [] });
    expect(bad.valid).toBe(false);
    expect(bad.nextState.pipelinesRun).toBe(0);

    const good = validateAndCountPipeline(state, {
      mode: "sequential",
      steps: [{ command: "echo ok" }],
    });
    expect(good.valid).toBe(true);
    expect(good.nextState.pipelinesRun).toBe(1);
  });
});
