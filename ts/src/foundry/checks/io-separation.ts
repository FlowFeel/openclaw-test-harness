/**
 * Foundry Axiom 1 Checker — Pure Logic / I/O Separation.
 *
 * @invariants
 * - Pure logic files (suffix -logic.ts, slices/<name>/logic.ts, slices/<name>/state.ts) import no Node I/O builtins.
 * - Entry files (src/index.ts) do not import node:fs directly; I/O goes through Protocol adapters.
 *
 * @dft
 * - Pure: operates on in-memory PluginTree, zero filesystem access.
 */

import type { PluginTree, Violation } from "../types.js";
import { importStatementGlobal } from "../foundry-regex-utils.js";

const IO_BUILTINS = new Set([
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:os",
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:dns",
  "node:stream",
  "node:readline",
  "node:worker_threads",
  "node:cluster",
]);

/** Extract module specifiers from import/re-export statements in TS source. */
export function extractImports(source: string): string[] {
  const imports: string[] = [];
  const re = importStatementGlobal();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/** True if a file path is a pure logic or state slice file. */
export function isLogicFile(path: string): boolean {
  if (path.endsWith(".spec.ts") || path.endsWith(".test.ts")) return false;
  return (
    path.endsWith("-logic.ts") ||
    path.endsWith("/logic.ts") ||
    path.endsWith("/state.ts")
  );
}

/** True if a file path is the plugin entry (the wiring layer). */
export function isEntryFile(path: string): boolean {
  return path === "src/index.ts" || path.endsWith("/src/index.ts");
}

export function checkPureIoSeparation(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!path.endsWith(".ts")) continue;
    const imports = extractImports(content);

    if (isLogicFile(path)) {
      for (const mod of imports) {
        if (IO_BUILTINS.has(mod)) {
          violations.push({
            axiom: "pure-io-separation",
            file: path,
            message: `Logic file imports I/O module "${mod}" — logic must be pure (no I/O). Move I/O to the *-io.ts or io.ts wrapper.`,
            severity: "error",
          });
        }
      }
    }

    if (isEntryFile(path)) {
      for (const mod of imports) {
        if (mod === "node:fs" || mod === "node:fs/promises") {
          violations.push({
            axiom: "pure-io-separation",
            file: path,
            message: `Entry file imports "${mod}" directly — I/O must go through the Protocol wrapper (*-io.ts), not node:fs.`,
            severity: "error",
          });
        }
      }
    }
  }
  return violations;
}
