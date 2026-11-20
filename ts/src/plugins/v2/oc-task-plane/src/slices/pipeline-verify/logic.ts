/**
 * Pipeline & Staging Verification Pure Transition Algebra.
 *
 * @invariants
 * - Pure logic: zero HTTP/process I/O, returns explicit CheckResult snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/pipeline-verify/tests/logic.spec.ts.
 */

import {
  evaluateRevisionMatch,
  type StagingRevisionVerdict,
} from "../../staging-verify-logic.js";
import {
  validatePipelineSpec,
  type NormalizedPipelineSpec,
} from "../../exec-pipeline-logic.js";
import type { FetchRevisionResult } from "../../staging-verify-io.js";
import type { PipelineVerifySliceState } from "./state.js";

export function verifyStagingPayload(
  state: PipelineVerifySliceState,
  fetchResult: FetchRevisionResult,
  expectedSha: string,
): { nextState: PipelineVerifySliceState; verdict: StagingRevisionVerdict } {
  const verdict = evaluateRevisionMatch(
    fetchResult.ok ? fetchResult.payload : null,
    expectedSha,
  );
  return {
    verdict,
    nextState: { ...state, verificationsRun: state.verificationsRun + 1 },
  };
}

export function validateAndCountPipeline(
  state: PipelineVerifySliceState,
  rawSpec: unknown,
): {
  nextState: PipelineVerifySliceState;
  valid: boolean;
  spec?: NormalizedPipelineSpec;
  error?: string;
} {
  const check = validatePipelineSpec(rawSpec);
  if (!check.ok) {
    return { nextState: state, valid: false, error: check.error };
  }
  return {
    valid: true,
    spec: check.spec,
    nextState: { ...state, pipelinesRun: state.pipelinesRun + 1 },
  };
}
