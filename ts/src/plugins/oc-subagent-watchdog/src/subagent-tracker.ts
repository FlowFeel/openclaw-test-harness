/**
 * Legacy v1 re-export shim for oc-subagent-watchdog/subagent-tracker.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../v2/oc-task-plane/src/subagent-tracker.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../v2/oc-task-plane/src/subagent-tracker.js";
