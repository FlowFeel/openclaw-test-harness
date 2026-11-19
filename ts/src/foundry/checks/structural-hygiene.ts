/**
 * Foundry Structural Hygiene Checkers — Reachability, Regex Centralization,
 * Silent Catch Ban, Type Safety, and Small File / Small Unit Ceilings.
 *
 * @invariants
 * - Every source file under src/ must be reachable from src/index.ts (or worker entrypoints).
 * - Zero inline regex literals outside regex-library.ts / *-regex-utils.ts / utils.ts.
 * - Zero empty catch {} blocks in src/.
 * - Zero any / as never type-erasure seams in src/.
 * - File size <= maxFileLines (default 300L), function size <= maxFnLines (default 80L).
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import {
  relativeImportGlobal,
  emptyCatchGlobal,
  typeErasureGlobal,
  INLINE_REGEX_METHOD_CALL,
  INLINE_REGEX_LITERAL_EXEC,
  FUNCTION_DECL_REGEX,
} from "../foundry-regex-utils.js";
import { stripComments } from "./determinism.js";

export interface StructuralHygieneOptions {
  maxFileLines?: number;
  maxFnLines?: number;
  severity?: "error" | "warn";
}

function isPluginSourceFile(path: string): boolean {
  if (!path.startsWith("src/") || !path.endsWith(".ts")) return false;
  if (path.endsWith(".spec.ts") || path.endsWith(".test.ts") || path.endsWith(".d.ts")) return false;
  return true;
}

function resolveRelativeTsPath(fromFile: string, specifier: string): string {
  const baseParts = fromFile.split("/").slice(0, -1);
  const specClean = specifier.replace(/\.(js|ts)$/, "");
  for (const part of specClean.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return `${baseParts.join("/")}.ts`;
}

/** Reachability BFS: detects dead / phantom modules inside src/. */
export function checkReachability(
  tree: PluginTree,
  severity: "error" | "warn" = "error",
): Violation[] {
  const sourceFiles = new Set<string>();
  for (const path of tree.files.keys()) {
    if (isPluginSourceFile(path)) sourceFiles.add(path);
  }
  if (!sourceFiles.has("src/index.ts")) return [];

  const entrypoints = ["src/index.ts", "src/sidecar-server.ts", "src/worker-entry.ts"]
    .filter((p) => sourceFiles.has(p));

  const visited = new Set<string>();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const content = tree.files.get(current) ?? "";
    const re = relativeImportGlobal();
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const target = resolveRelativeTsPath(current, m[1]);
      if (sourceFiles.has(target) && !visited.has(target)) {
        queue.push(target);
      }
    }
  }

  const violations: Violation[] = [];
  for (const file of sourceFiles) {
    if (!visited.has(file)) {
      violations.push({
        axiom: "reachability",
        file,
        message: `Unreachable source file "${file}" — not imported from src/index.ts or any worker entrypoint (phantom/dead module).`,
        severity,
      });
    }
  }
  return violations;
}

/** Regex Centralization: bans inline regex literals outside regex utility modules. */
export function checkNoInlineRegex(
  tree: PluginTree,
  severity: "error" | "warn" = "error",
): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isPluginSourceFile(path)) continue;
    if (
      path.endsWith("regex-library.ts") ||
      path.endsWith("regex-utils.ts") ||
      path.endsWith("/utils.ts")
    ) {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      if (INLINE_REGEX_METHOD_CALL.test(trimmed) || INLINE_REGEX_LITERAL_EXEC.test(trimmed)) {
        violations.push({
          axiom: "no-inline-regex",
          file: path,
          message: `Line ${i + 1}: inline regex literal detected — centralize patterns in shared/regex-library.ts or *-regex-utils.ts.`,
          severity,
        });
      }
    }
  }
  return violations;
}

/** Silent Catch Ban: flags empty catch {} blocks that swallow errors without proof. */
export function checkNoEmptyCatch(
  tree: PluginTree,
  severity: "error" | "warn" = "error",
): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isPluginSourceFile(path)) continue;
    const re = emptyCatchGlobal();
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      violations.push({
        axiom: "no-empty-catch",
        file: path,
        message: `Line ${lineNo}: empty catch {} block swallows errors silently — return a typed CheckResult or log via api.logger.`,
        severity,
      });
    }
  }
  return violations;
}

/** Type Safety: flags any / as never type-erasure seams in plugin source. */
export function checkNoTypeErasure(
  tree: PluginTree,
  severity: "error" | "warn" = "error",
): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isPluginSourceFile(path)) continue;
    const stripped = stripComments(content);
    const matches = stripped.match(typeErasureGlobal());
    if (matches && matches.length > 0) {
      violations.push({
        axiom: "no-type-erasure",
        file: path,
        message: `Source file contains ${matches.length} type-erasure seam(s) (any / as never) — use explicit Protocol or union types.`,
        severity,
      });
    }
  }
  return violations;
}

/** Small Files & Small Units: enforces line ceilings on files and functions. */
export function checkUnitSizeCeilings(
  tree: PluginTree,
  options?: StructuralHygieneOptions,
): Violation[] {
  const maxFileLines = options?.maxFileLines ?? 300;
  const maxFnLines = options?.maxFnLines ?? 80;
  const severity = options?.severity ?? "error";
  const violations: Violation[] = [];

  for (const [path, content] of tree.files) {
    if (!isPluginSourceFile(path)) continue;
    const lines = content.split("\n");
    if (lines.length > maxFileLines) {
      violations.push({
        axiom: "small-files",
        file: path,
        message: `File has ${lines.length} lines (ceiling: ${maxFileLines}) — decompose into smaller cohesive slices.`,
        severity,
      });
    }

    let i = 0;
    while (i < lines.length) {
      const m = FUNCTION_DECL_REGEX.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      const fnName = m[1];
      let depth = 0;
      let started = false;
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") {
            depth--;
          }
        }
        if (started && depth <= 0) {
          const fnLen = j - i + 1;
          if (fnLen > maxFnLines) {
            violations.push({
              axiom: "small-units",
              file: path,
              message: `Function "${fnName}" is ${fnLen} lines (ceiling: ${maxFnLines}) — extract cohesive pure helpers.`,
              severity,
            });
          }
          break;
        }
        j++;
      }
      i = j + 1;
    }
  }
  return violations;
}
