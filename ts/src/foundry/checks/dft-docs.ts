/**
 * Foundry Axiom 4 Checker — Structural DFT Documentation.
 *
 * @invariants
 * - Every source .ts file in src/ carries @dft or @invariants in its docblock.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import { DFT_TAG_REGEX, INVARIANTS_TAG_REGEX } from "../foundry-regex-utils.js";

export function checkDftDocs(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!path.startsWith("src/") && !path.includes("/src/")) continue;
    if (!path.endsWith(".ts")) continue;
    if (path.endsWith(".spec.ts") || path.endsWith(".test.ts")) continue;

    const hasDft = DFT_TAG_REGEX.test(content);
    const hasInvariants = INVARIANTS_TAG_REGEX.test(content);
    if (!hasDft && !hasInvariants) {
      violations.push({
        axiom: "dft-docs",
        file: path,
        message: "Source file lacks @dft or @invariants docblock — every source file must declare its testability contract.",
        severity: "error",
      });
    }
  }
  return violations;
}

