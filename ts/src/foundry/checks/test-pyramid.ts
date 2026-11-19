/**
 * Foundry Test Pyramid Checker — enforces Tier 1 (Slice Unit) & Tier 2 (Integration/Manifest)
 * test symmetry for modular slice plugins.
 *
 * @invariants
 * - Every vertical slice under src/slices/<name>/ with a logic.ts must have a corresponding
 *   tests/logic.spec.ts (or <name>-logic.spec.ts) unit test.
 * - Every sliced plugin must include integration and manifest test suites.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";

export function checkTestPyramid(
  tree: PluginTree,
  severity: "error" | "warn" = "error",
): Violation[] {
  const violations: Violation[] = [];
  const sliceNames = new Set<string>();

  for (const path of tree.files.keys()) {
    const parts = path.split("/");
    if (parts[0] === "src" && parts[1] === "slices" && parts[2] && parts[3] === "logic.ts") {
      sliceNames.add(parts[2]);
    }
  }

  if (sliceNames.size === 0) return [];

  for (const slice of sliceNames) {
    const expectedUnitTest = `src/slices/${slice}/tests/logic.spec.ts`;
    const altUnitTest = `tests/${slice}-logic.spec.ts`;
    if (!tree.files.has(expectedUnitTest) && !tree.files.has(altUnitTest)) {
      violations.push({
        axiom: "test-pyramid",
        file: `src/slices/${slice}/logic.ts`,
        message: `Vertical slice "${slice}" lacks a Tier 1 unit test (${expectedUnitTest}).`,
        severity,
      });
    }
  }

  const hasIntegration = Array.from(tree.files.keys()).some(
    (p) => p.endsWith(".spec.ts") && p.includes("integration"),
  );
  if (!hasIntegration) {
    violations.push({
      axiom: "test-pyramid",
      file: "tests/integration.spec.ts",
      message: "Plugin lacks a Tier 2 integration test suite (tests/integration.spec.ts).",
      severity,
    });
  }

  const hasManifestTest = Array.from(tree.files.keys()).some(
    (p) => p.endsWith(".spec.ts") && p.includes("manifest"),
  );
  if (!hasManifestTest) {
    violations.push({
      axiom: "test-pyramid",
      file: "tests/manifest.spec.ts",
      message: "Plugin lacks a Tier 2 bidirectional manifest test (tests/manifest.spec.ts).",
      severity,
    });
  }

  return violations;
}

