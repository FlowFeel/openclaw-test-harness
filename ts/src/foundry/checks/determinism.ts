/**
 * Foundry Axiom 2 Checker — Strict Determinism.
 *
 * @invariants
 * - Pure logic/state files never call Date.now(), Math.random(), or new Date().
 * - Time and randomness are injected as explicit parameters.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import {
  BLOCK_COMMENT_GLOBAL,
  LINE_COMMENT_PREFIX,
  DATE_NOW_REGEX,
  MATH_RANDOM_REGEX,
  NEW_DATE_REGEX,
} from "../foundry-regex-utils.js";
import { isLogicFile } from "./io-separation.js";

const NONDETERMINISM_PATTERNS: ReadonlyArray<{ re: Readonly<RegExp>; label: string }> = [
  { re: DATE_NOW_REGEX, label: "Date.now()" },
  { re: MATH_RANDOM_REGEX, label: "Math.random()" },
  { re: NEW_DATE_REGEX, label: "new Date()" },
];

export function stripComments(source: string): string {
  const withoutBlock = source.replace(BLOCK_COMMENT_GLOBAL(), "");
  return withoutBlock
    .split("\n")
    .filter((line) => !LINE_COMMENT_PREFIX.test(line))
    .join("\n");
}

export function checkDeterminism(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isLogicFile(path)) continue;
    const stripped = stripComments(content);

    for (const { re, label } of NONDETERMINISM_PATTERNS) {
      if (re.test(stripped)) {
        violations.push({
          axiom: "determinism",
          file: path,
          message: `Logic file calls ${label} — time/randomness must be injected as a parameter for deterministic testing.`,
          severity: "error",
        });
      }
    }
  }
  return violations;
}

