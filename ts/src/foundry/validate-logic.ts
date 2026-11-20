/**
 * Foundry validator — pure composite entrypoint assembling all Phosphene DFT
 * axiom checks (A1–A6) and structural hygiene ratchets.
 *
 * @invariants
 * - validatePlugin / validatePluginStrict are pure: same PluginTree in → same Violation[] out.
 * - No I/O, no filesystem, no network, zero inline regexes.
 *
 * @dft
 * - Tested via tests/foundry/validate-logic.spec.ts with inline PluginTrees.
 */

import type { PluginTree, Violation } from "./types.js";
import { checkPureIoSeparation, extractImports, isLogicFile, isEntryFile } from "./checks/io-separation.js";
import { checkDeterminism } from "./checks/determinism.js";
import {
  checkManifestConformance,
  extractRegisteredTools,
  extractRegisteredHooks,
} from "./checks/manifest-conformance.js";
import { checkDftDocs } from "./checks/dft-docs.js";
import { checkMockDoubles } from "./checks/test-doubles.js";
import { checkCheckResult } from "./checks/check-result.js";
import {
  checkReachability,
  checkNoInlineRegex,
  checkNoEmptyCatch,
  checkNoTypeErasure,
  checkUnitSizeCeilings,
  type StructuralHygieneOptions,
} from "./checks/structural-hygiene.js";
import { checkTestPyramid } from "./checks/test-pyramid.js";

export interface ValidateOptions {
  checkHooks?: boolean;
  strictHygiene?: boolean;
  hygiene?: StructuralHygieneOptions;
}

/** Validate a plugin tree against core Phosphene DFT axioms (A1–A6). */
export function validatePlugin(tree: PluginTree, options?: ValidateOptions): Violation[] {
  const core: Violation[] = [
    ...checkPureIoSeparation(tree),
    ...checkDeterminism(tree),
    ...checkManifestConformance(tree, { checkHooks: options?.checkHooks }),
    ...checkDftDocs(tree),
    ...checkMockDoubles(tree),
    ...checkCheckResult(tree),
  ];

  if (!options?.strictHygiene) {
    return core;
  }

  const sev = options.hygiene?.severity ?? "error";
  return [
    ...core,
    ...checkReachability(tree, sev),
    ...checkNoInlineRegex(tree, sev),
    ...checkNoEmptyCatch(tree, sev),
    ...checkNoTypeErasure(tree, sev),
    ...checkUnitSizeCeilings(tree, options.hygiene),
    ...checkTestPyramid(tree, sev),
  ];
}

/** Strict Phosphene DFT validation: A1–A6 + hooks + reachability + regex + error + size + pyramid. */
export function validatePluginStrict(
  tree: PluginTree,
  hygiene?: StructuralHygieneOptions,
): Violation[] {
  return validatePlugin(tree, { checkHooks: true, strictHygiene: true, hygiene });
}

/** True if the tree has any error-severity violations (fails CI). */
export function hasErrors(violations: Violation[]): boolean {
  return violations.some((v) => v.severity === "error");
}

export {
  checkPureIoSeparation,
  checkDeterminism,
  checkManifestConformance,
  checkDftDocs,
  checkMockDoubles,
  checkCheckResult,
  checkReachability,
  checkNoInlineRegex,
  checkNoEmptyCatch,
  checkNoTypeErasure,
  checkUnitSizeCeilings,
  checkTestPyramid,
  extractImports,
  extractRegisteredTools,
  extractRegisteredHooks,
  isLogicFile,
  isEntryFile,
};
