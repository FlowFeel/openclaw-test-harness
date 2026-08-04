/**
 * Foundry validator — PURE logic for checking a plugin against the six
 * phosphene DFT axioms.
 *
 * @behavior
 * Takes a PluginTree (in-memory file map + parsed manifest) and returns a list
 * of Violations. Each axiom is a separate pure check function. The validator
 * never touches the filesystem — it operates on the in-memory representation
 * so it is testable in 0ms with zero fixtures.
 *
 * @invariants
 * - validatePlugin is pure: same PluginTree in → same Violation[] out.
 * - No I/O, no filesystem, no network.
 * - Every Violation carries its own proof (file + message + severity).
 * - Axioms 1-4 are "error" severity (fail CI); 5-6 are "warn" (advisory).
 *
 * @dft
 * - Tested via tests/foundry/validate-logic.spec.ts with inline PluginTrees.
 * - No fixtures: test data is constructed inline.
 * - Deterministic: no Date.now(), no Math.random().
 *
 * @axioms
 * 1. pure-io-separation — logic files import no I/O; index.ts imports no node:fs
 * 2. determinism — logic files have no Date.now()/Math.random()/new Date()
 * 3. manifest-conformance — declared tools/hooks match registered tools/hooks
 * 4. dft-docs — every source .ts file has @dft or @invariants
 * 5. mock-doubles — integration tests don't use vi.fn() as Protocol stand-ins
 * 6. check-result — mutating logic functions return a report, not void
 */

import type { PluginTree, Violation } from "./types.js";

// ── Axiom 1: Pure logic / I/O separation ─────────────────────────────────
// Logic files (*-logic.ts) must not import I/O modules. The wiring (index.ts)
// must not import node:fs directly — I/O goes through the Protocol wrapper.

/** Node builtin modules that perform I/O — banned in logic files. */
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

/** Extract module specifiers from import statements in TS source. */
function extractImports(source: string): string[] {
  const imports: string[] = [];
  // Match: import ... from "specifier";
  const re = /^\s*import\s+[^;]*?from\s+["']([^"']+)["'];/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/** True if a file path is a logic file (the pure seam). */
function isLogicFile(path: string): boolean {
  return path.endsWith("-logic.ts") && !path.endsWith(".spec.ts");
}

/** True if a file path is the plugin entry (the wiring layer). */
function isEntryFile(path: string): boolean {
  return path === "src/index.ts" || path.endsWith("/src/index.ts");
}

function checkPureIoSeparation(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!path.endsWith(".ts")) continue;
    const imports = extractImports(content);

    if (isLogicFile(path)) {
      // Logic files: no I/O builtins at all.
      for (const mod of imports) {
        if (IO_BUILTINS.has(mod)) {
          violations.push({
            axiom: "pure-io-separation",
            file: path,
            message: `Logic file imports I/O module "${mod}" — logic must be pure (no I/O). Move I/O to the *-io.ts wrapper.`,
            severity: "error",
          });
        }
      }
    }

    if (isEntryFile(path)) {
      // Entry/wiring files: no direct node:fs — I/O goes through the Protocol.
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

// ── Axiom 2: Determinism ────────────────────────────────────────────────
// Logic files must not call Date.now(), Math.random(), or new Date() — these
// are nondeterminism injection points. Time must be injected as a parameter.

/** Patterns that inject nondeterminism. */
const NONDETERMINISM_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bDate\.now\s*\(/, label: "Date.now()" },
  { re: /\bMath\.random\s*\(/, label: "Math.random()" },
  { re: /\bnew\s+Date\s*\(/, label: "new Date()" },
];

/** Strip block comments (/* ... *\/) and line comments (// ...) from TS source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
}

function checkDeterminism(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isLogicFile(path)) continue;
    const code = stripComments(content);
    for (const { re, label } of NONDETERMINISM_PATTERNS) {
      if (re.test(code)) {
        violations.push({
          axiom: "determinism",
          file: path,
          message: `Logic file contains ${label} — inject time as a parameter (nowMs) for deterministic tests.`,
          severity: "error",
        });
      }
    }
  }
  return violations;
}

// ── Axiom 3: Manifest conformance ───────────────────────────────────────
// The manifest's declared contracts.tools must match the tools actually
// registered in index.ts via registerTool({ name: "..." }).

/** Extract registered tool names from index.ts source. */
function extractRegisteredTools(source: string): string[] {
  const tools: string[] = [];
  // Match: registerTool({ name: "tool-name" ... or registerTool({\n name: "tool-name"
  const re = /registerTool\s*\(\s*\{[^}]*?name\s*:\s*["']([^"']+)["']/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    tools.push(m[1]);
  }
  return tools;
}

/** Extract registered hook events from index.ts source. */
function extractRegisteredHooks(source: string): string[] {
  const hooks: string[] = [];
  // Match: registerHook("event", ... or registerHook(["e1", "e2"], ...
  const re = /registerHook\s*\(\s*(?:["']([^"']+)["']|\[([^\]]*)\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) {
      hooks.push(m[1]);
    } else if (m[2]) {
      // Array form: extract each quoted string
      const inner = m[2].matchAll(/["']([^"']+)["']/g);
      for (const im of inner) hooks.push(im[1]);
    }
  }
  return hooks;
}

function checkManifestConformance(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  if (!tree.manifest) {
    violations.push({
      axiom: "manifest-conformance",
      message: "Manifest (openclaw.plugin.json) is missing or invalid.",
      severity: "error",
    });
    return violations;
  }

  // Find the entry file to check registered tools/hooks.
  let entryContent: string | undefined;
  for (const [path, content] of tree.files) {
    if (isEntryFile(path)) {
      entryContent = content;
      break;
    }
  }
  if (!entryContent) return violations; // no entry file → other checks handle it

  const declaredTools = tree.manifest.contracts?.tools ?? [];
  const registeredTools = extractRegisteredTools(entryContent);

  // Declared but not registered.
  for (const tool of declaredTools) {
    if (!registeredTools.includes(tool)) {
      violations.push({
        axiom: "manifest-conformance",
        file: "src/index.ts",
        message: `Manifest declares tool "${tool}" but it is not registered in index.ts.`,
        severity: "error",
      });
    }
  }
  // Registered but not declared.
  for (const tool of registeredTools) {
    if (!declaredTools.includes(tool)) {
      violations.push({
        axiom: "manifest-conformance",
        file: "src/index.ts",
        message: `index.ts registers tool "${tool}" but it is not declared in the manifest.`,
        severity: "error",
      });
    }
  }

  return violations;
}

// ── Axiom 4: DFT documentation ──────────────────────────────────────────
// Every source .ts file must have @dft or @invariants in its leading docblock.

function checkDftDocs(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    // Only check source files in src/, not tests.
    if (!path.startsWith("src/") && !path.includes("/src/")) continue;
    if (!path.endsWith(".ts")) continue;
    if (path.endsWith(".spec.ts") || path.endsWith(".test.ts")) continue;

    const hasDft = /@dft/.test(content);
    const hasInvariants = /@invariants/.test(content);
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

// ── Axiom 5: Mock doubles, not mocks ────────────────────────────────────
// Integration tests should use real Protocol doubles, not vi.fn() as stand-ins.
// This is a heuristic check (warn, not error) — vi.fn() for individual handler
// assertions is fine, but vi.fn() as a Protocol implementation is not.

function checkMockDoubles(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    // Only check integration test files.
    if (!path.includes("integration") && !path.endsWith(".integration.spec.ts")) continue;

    // Heuristic: if vi.fn() appears AND there's no real class/object implementing
    // a Protocol (no "implements" keyword, no "class" keyword for doubles),
    // warn. A real double is a class or object literal, not vi.fn().
    const viFnCount = (content.match(/\bvi\.fn\s*\(/g) || []).length;
    if (viFnCount > 0) {
      const hasRealDouble = /\bclass\s+\w+\s+implements\b/.test(content) ||
        /const\s+\w+\s*:\s*\w*(Reader|Writer|Store|Pool|Server|Client)\b/.test(content);
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

// ── Axiom 6: CheckResult pattern ────────────────────────────────────────
// Pure functions that mutate state should return a report (CheckResult), not
// void. This is a heuristic check (warn) — we look for void-returning exported
// functions whose names suggest mutation.

const MUTATING_VERBS = /^(cleanup|purge|strip|apply|execute|run|process|flush|evict|remove|delete|clear)/i;

function checkCheckResult(tree: PluginTree): Violation[] {
  const violations: Violation[] = [];
  for (const [path, content] of tree.files) {
    if (!isLogicFile(path)) continue;

    // Find exported functions with void return type.
    // Match: export function name(...): void {
    const re = /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*:\s*void\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const fnName = m[1];
      if (MUTATING_VERBS.test(fnName)) {
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

// ── The composite validator ─────────────────────────────────────────────

/**
 * Validate a plugin tree against all six DFT axioms. Pure: same tree in →
 * same violations out. No I/O.
 */
export function validatePlugin(tree: PluginTree): Violation[] {
  return [
    ...checkPureIoSeparation(tree),
    ...checkDeterminism(tree),
    ...checkManifestConformance(tree),
    ...checkDftDocs(tree),
    ...checkMockDoubles(tree),
    ...checkCheckResult(tree),
  ];
}

/** True if the tree has any error-severity violations (fails CI). */
export function hasErrors(violations: Violation[]): boolean {
  return violations.some((v) => v.severity === "error");
}

// Re-export check functions for unit testing individual axioms.
export {
  checkPureIoSeparation,
  checkDeterminism,
  checkManifestConformance,
  checkDftDocs,
  checkMockDoubles,
  checkCheckResult,
  extractImports,
  extractRegisteredTools,
  extractRegisteredHooks,
  isLogicFile,
  isEntryFile,
};
