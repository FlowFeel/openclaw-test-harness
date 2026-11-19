/**
 * Legacy v1 re-export shim for oc-sidecar/session-cleanup.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../shared/session-cleanup.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../shared/session-cleanup.js";
