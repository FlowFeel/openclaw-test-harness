/**
 * OcE2eTraceTest — pure logic seam.
 *
 * @behavior
 * All decision logic for the oc-e2e-trace-test plugin. Pure functions take
 * immutable input, return a NEW object + a CheckResult report, and never
 * touch the filesystem, call Date.now(), or perform I/O.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:http, etc.).
 * - No Date.now() / Math.random() — time is injected via options.nowMs.
 * - Mutating functions return a report (CheckResult pattern).
 *
 * @dft
 * - Tested in e2e-trace-test-logic.spec.ts with inline data, zero fixtures.
 * - No filesystem, no clock — fully deterministic.
 */



