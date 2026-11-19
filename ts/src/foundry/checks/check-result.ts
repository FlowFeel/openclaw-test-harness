/**
 * Foundry Axiom 6 Checker — CheckResult / Mutation Proof Pattern.
 *
 * @invariants
 * - Mutating functions in pure logic/state files return a CheckResult/Report, not void.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import { MUTATING_VERBS_REGEX, exportedVoidFnGlobal } from "../foundry-regex-utils.js";
import { isLogicFile } from "./io-separation.js";

export function checkCheckResult(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isLogicFile(path)) continue;

    const re = exportedVoidFnGlobal();
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const fnName = m[1];
      if (MUTATING_VERBS_REGEX.test(fnName)) {
        violations.push({
          axiom: "check-result",
          file: path,
          message: `Function "${fnName}" returns void — mutating functions should return a CheckResult/Report carrying their own proof.`,
          severity: "warn",
        });
      }
    }
  }
  return violations;
}
