/**
 * Legacy v1 re-export shim for oc-sidecar/telemetry-logic.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../shared/telemetry-logic.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../shared/telemetry-logic.js";
