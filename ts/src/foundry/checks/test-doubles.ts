/**
 * Foundry Axiom 5 Checker — Real Protocol Doubles, Not Synthetic Mocks.
 *
 * @invariants
 * - Flags vi.mock() module monkey-patching in any test file.
 * - Flags integration tests using >2 vi.fn() calls without a real Protocol double.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import {
  viFnCallGlobal,
  viMockCallGlobal,
  REAL_DOUBLE_CLASS_REGEX,
  REAL_DOUBLE_CONST_REGEX,
} from "../foundry-regex-utils.js";

export function checkMockDoubles(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!path.endsWith(".spec.ts") && !path.endsWith(".test.ts")) continue;

    const viMockCount = (content.match(viMockCallGlobal()) || []).length;
    if (viMockCount > 0) {
      violations.push({
        axiom: "mock-doubles",
        file: path,
        message: `Test uses ${viMockCount} vi.mock() module patch(es) — inject Protocol doubles instead of monkey-patching modules.`,
        severity: "warn",
      });
    }

    if (!path.includes("integration") && !path.endsWith(".integration.spec.ts")) continue;

    const viFnCount = (content.match(viFnCallGlobal()) || []).length;
    if (viFnCount > 0) {
      const hasRealDouble =
        REAL_DOUBLE_CLASS_REGEX.test(content) ||
        REAL_DOUBLE_CONST_REGEX.test(content);
      if (!hasRealDouble && viFnCount > 2) {
        violations.push({
          axiom: "mock-doubles",
          file: path,
          message: `Integration test uses ${viFnCount} vi.fn() calls without a real Protocol double — use a real in-process implementation, not patch-over mocks.`,
          severity: "warn",
        });
      }
    }
  }
  return violations;
}
