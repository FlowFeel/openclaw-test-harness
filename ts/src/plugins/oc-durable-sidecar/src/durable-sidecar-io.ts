/**
 * Legacy v1 re-export shim for oc-durable-sidecar/durable-sidecar-io.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../v2/oc-task-plane/src/durable-sidecar-io.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../v2/oc-task-plane/src/durable-sidecar-io.js";
