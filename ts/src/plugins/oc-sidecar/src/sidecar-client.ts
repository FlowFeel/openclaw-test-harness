/**
 * Legacy v1 re-export shim for oc-sidecar/sidecar-client.ts.
 *
 * @invariants
 * - Delegates all implementation to canonical module ../../v2/oc-memory-nexus/src/sidecar-client.js (zero duplication).
 *
 * @dft
 * - Covered by canonical module unit & integration test suites.
 */

export * from "../../v2/oc-memory-nexus/src/sidecar-client.js";
