/**
 * Legacy v1 re-export shim for oc-topic-worker-pool/topic-worker-pool-logic.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../v2/oc-lane-supervisor/src/topic-worker-pool-logic.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../v2/oc-lane-supervisor/src/topic-worker-pool-logic.js";
