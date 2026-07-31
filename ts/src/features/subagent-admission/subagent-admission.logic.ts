/**
 * Subagent admission logic — pure functions with Effect for I/O.
 *
 * @behavior
 * Evaluates whether a spawn should be admitted based on depth, children,
 * concurrent, and timeout guards. Returns an AdmissionDecision — never
 * throws, never logs, never calls I/O directly.
 *
 * @invariants
 * - Guard order is fixed: depth → concurrent → timeout → children.
 * - Every rejection includes evidence with all metrics.
 * - The function is total — no exceptions for valid inputs.
 *
 * @remarks
 * This is the TypeScript mirror of Python's `resolve_admission`. Same
 * guard order, same evidence shape. When we patch OC's `child-admission.ts`,
 * the patch imports this function so OC uses the same admission logic
 * our tests verify. The patch is minimal — swap `resolveChildAdmission`
 * for `resolveAdmission` with two extra guards.
 *
 * @architecture
 * Upstream: OC's `spawn-plan.ts` reads config, calls `resolveAdmission`
 * Downstream: OC's spawn pipeline uses the decision to proceed or reject
 * Parallel: Python `admission.py` — same guards, different runtime
 */

import { Effect } from "effect"
import {
  AdmissionDecision,
  AdmissionPolicy,
} from "./subagent-admission.schema.js"
import type { AdmissionCap } from "./subagent-admission.schema.js"

/**
 * Evaluate whether a spawn should be admitted.
 *
 * @param callerDepth - Spawn depth of the calling session, $d \\geq 0$.
 * @param activeChildren - Active children the caller already has.
 * @param globalActive - Total active subagents across all parents.
 * @param timedOutSubagents - Session keys exceeding runTimeoutSeconds.
 * @param policy - Admission policy from OC config.
 * @param collect - Whether this is a swarm collect operation.
 * @param totalChildren - Total children in the group (swarm only).
 * @returns AdmissionDecision with ok/rejected + reason + evidence.
 */
export function resolveAdmission(params: {
  callerDepth: number
  activeChildren: number
  globalActive: number
  timedOutSubagents: ReadonlyArray<string>
  policy: AdmissionPolicy
  collect?: boolean
  totalChildren?: number
}): AdmissionDecision {
  const {
    callerDepth,
    activeChildren,
    globalActive,
    timedOutSubagents,
    policy,
    collect = false,
    totalChildren = 0,
  } = params

  const evidence = {
    callerDepth,
    activeChildren,
    globalActive,
    maxSpawnDepth: policy.maxSpawnDepth,
    maxChildrenPerAgent: policy.maxChildrenPerAgent,
    maxConcurrent: policy.maxConcurrent,
  }

  // Guard 1: maxSpawnDepth (from OC)
  if (callerDepth >= policy.maxSpawnDepth) {
    return reject(
      "subagents.maxSpawnDepth",
      `sessions_spawn is not allowed at this depth ` +
        `(current: ${callerDepth}, max: ${policy.maxSpawnDepth})`,
      evidence,
    )
  }

  // Guard 2: maxConcurrent (our extension — global, not per-parent)
  if (globalActive >= policy.maxConcurrent) {
    return reject(
      "subagents.maxConcurrent",
      `sessions_spawn has reached global max concurrent ` +
        `(${globalActive}/${policy.maxConcurrent})`,
      evidence,
    )
  }

  // Guard 3: runTimeoutSeconds (our extension — block if timed-out subs exist)
  if (timedOutSubagents.length > 0) {
    return reject(
      "subagents.runTimeoutSeconds",
      `sessions_spawn blocked: ${timedOutSubagents.length} ` +
        `subagent(s) have exceeded runTimeoutSeconds ` +
        `(${policy.runTimeoutSeconds}s) and must be cleaned up`,
      { ...evidence, timedOut: timedOutSubagents },
    )
  }

  // Guard 4: swarm total (from OC, collect mode only)
  if (
    collect &&
    policy.maxTotalPerGroup !== undefined &&
    totalChildren >= policy.maxTotalPerGroup
  ) {
    return reject(
      "tools.swarm.maxTotalPerGroup",
      `sessions_spawn reached maxTotalPerGroup ` +
        `(${totalChildren}/${policy.maxTotalPerGroup})`,
      evidence,
    )
  }

  // Guard 5: maxChildrenPerAgent (from OC)
  if (activeChildren >= policy.maxChildrenPerAgent) {
    const cap: AdmissionCap = collect
      ? "tools.swarm.maxChildrenPerGroup"
      : "subagents.maxChildrenPerAgent"
    return reject(
      cap,
      `sessions_spawn has reached max active children ` +
        `(${activeChildren}/${policy.maxChildrenPerAgent})`,
      evidence,
    )
  }

  return { ok: true, reason: "Admitted", evidence }
}

function reject(
  cap: AdmissionCap,
  reason: string,
  evidence: Record<string, unknown>,
): AdmissionDecision {
  return { ok: false, cap, reason, evidence }
}

// ── Effect-wrapped version for logic layer ────────────────────

/**
 * Effect-based admission check with DI for store queries.
 *
 * @param policy - Admission policy.
 * @param store - Session store protocol (I/O injected via Effect).
 * @returns Effect that resolves to an AdmissionDecision.
 */
export const checkAdmission = Effect.fn("checkAdmission")(
  function* (
    parentKey: string,
    callerDepth: number,
    policy: AdmissionPolicy,
    store: {
      getActiveCount: () => Effect.Effect<number>
      getChildrenCount: (parentKey: string) => Effect.Effect<number>
      getTimedOutSubagents: (
        timeoutSeconds: number,
      ) => Effect.Effect<ReadonlyArray<string>>
    },
  ) {
    const globalActive = yield* store.getActiveCount()
    const activeChildren = yield* store.getChildrenCount(parentKey)
    const timedOut = yield* store.getTimedOutSubagents(
      policy.runTimeoutSeconds,
    )

    return resolveAdmission({
      callerDepth,
      activeChildren,
      globalActive,
      timedOutSubagents: timedOut,
      policy,
    })
  },
)
