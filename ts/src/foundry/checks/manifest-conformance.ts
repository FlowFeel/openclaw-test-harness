/**
 * Foundry Axiom 3 Checker — Bidirectional Manifest Conformance (Tools + Hooks).
 *
 * @invariants
 * - openclaw.plugin.json contracts.tools matches all registered tools across src/index.ts and slices.
 * - When checkHooks is enabled (default in strict mode), contracts.hooks matches all registered hooks.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import {
  registerToolGlobal,
  registerHookGlobal,
  quotedStringGlobal,
} from "../foundry-regex-utils.js";
import { isEntryFile } from "./io-separation.js";

/** Extract registered tool names from TS wiring source. */
export function extractRegisteredTools(source: string): string[] {
  const tools: string[] = [];
  const re = registerToolGlobal();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    tools.push(m[1]);
  }
  return tools;
}

/** Extract registered hook events from TS wiring source (registerHook and api.on). */
export function extractRegisteredHooks(source: string): string[] {
  const hooks: string[] = [];
  const re = registerHookGlobal();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) {
      hooks.push(m[1]);
      continue;
    }
    if (m[2]) {
      const inner = m[2].matchAll(quotedStringGlobal());
      for (const im of inner) hooks.push(im[1]);
    }
  }
  return hooks;
}

function isWiringFile(path: string): boolean {
  if (path.endsWith(".spec.ts") || path.endsWith(".test.ts")) return false;
  return isEntryFile(path) || path.endsWith("/slice.ts") || path.includes("/hooks/") || path.includes("/tools/");
}

export function checkManifestConformance(
  tree: PluginTree,
  options?: { checkHooks?: boolean },
): Violation[] {
  const violations: Violation[] = [];
  if (!tree.manifest) {
    violations.push({
      axiom: "manifest-conformance",
      message: "Manifest (openclaw.plugin.json) is missing or invalid.",
      severity: "error",
    });
    return violations;
  }

  const wiringSources: string[] = [];
  for (const [path, content] of tree.files) {
    if (isWiringFile(path)) {
      wiringSources.push(content);
    }
  }
  if (wiringSources.length === 0) return violations;

  const combinedWiring = wiringSources.join("\n");
  const declaredTools = tree.manifest.contracts?.tools ?? [];
  const registeredTools = Array.from(new Set(extractRegisteredTools(combinedWiring)));

  for (const tool of declaredTools) {
    if (!registeredTools.includes(tool)) {
      violations.push({
        axiom: "manifest-conformance",
        file: "src/index.ts",
        message: `Manifest declares tool "${tool}" but it is not registered in plugin wiring.`,
        severity: "error",
      });
    }
  }
  for (const tool of registeredTools) {
    if (!declaredTools.includes(tool)) {
      violations.push({
        axiom: "manifest-conformance",
        file: "src/index.ts",
        message: `Plugin wiring registers tool "${tool}" but it is not declared in the manifest.`,
        severity: "error",
      });
    }
  }

  if (options?.checkHooks) {
    const declaredHooks = tree.manifest.contracts?.hooks ?? [];
    const registeredHooks = Array.from(new Set(extractRegisteredHooks(combinedWiring)));

    for (const hook of declaredHooks) {
      if (!registeredHooks.includes(hook)) {
        violations.push({
          axiom: "manifest-conformance",
          file: "src/index.ts",
          message: `Manifest declares hook "${hook}" but it is not registered in plugin wiring.`,
          severity: "error",
        });
      }
    }
    for (const hook of registeredHooks) {
      if (!declaredHooks.includes(hook)) {
        violations.push({
          axiom: "manifest-conformance",
          file: "src/index.ts",
          message: `Plugin wiring registers hook "${hook}" but it is not declared in the manifest.`,
          severity: "error",
        });
      }
    }
  }

  return violations;
}

