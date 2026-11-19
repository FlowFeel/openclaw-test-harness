/**
 * Foundry validator — pure logic unit tests.
 *
 * @dft
 * - Pure: inline PluginTrees, zero fixtures, no filesystem.
 * - Deterministic: no Date.now(), no Math.random().
 * - Tests all six axioms: green (compliant) and red (violating) cases.
 */

import { describe, it, expect } from "vitest";
import {
  validatePlugin,
  validatePluginStrict,
  hasErrors,
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
} from "../../src/foundry/validate-logic.js";
import type { PluginTree, Violation } from "../../src/foundry/types.js";

// ── Helpers: build inline plugin trees ───────────────────────────────────

function tree(name: string, files: Record<string, string>, manifest?: unknown): PluginTree {
  return {
    name,
    manifest: (manifest ?? null) as PluginTree["manifest"],
    files: new Map(Object.entries(files)),
  };
}

const COMPLIANT_LOGIC = `/**
 * @dft pure logic
 * @invariants no I/O, no Date.now()
 */

export interface Report { count: number; }

export function processItems(input: { items: unknown[] }, opts: { nowMs: number }): { result: unknown; report: Report } {
  return { result: input.items.length, report: { count: input.items.length } };
}
`;

const COMPLIANT_INDEX = `/**
 * @dft wiring layer
 * @invariants no direct node:fs
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { processItems } from "./my-logic.js";

export default definePluginEntry({
  id: "oc-test",
  name: "OcTest",
  description: "test",
  register(api: PluginApi) {
    api.registerHook("session_end", async () => {}, { name: "test" });
    api.registerTool({
      name: "test_tool",
      description: "test",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "ok" }] }; },
    });
  },
});
`;

const COMPLIANT_MANIFEST = {
  id: "oc-test",
  name: "OcTest",
  description: "test",
  contracts: { tools: ["test_tool"], hooks: ["session_end"] },
};

// ── Axiom 1: Pure / I/O separation ───────────────────────────────────────

describe("Axiom 1: pure-io-separation", () => {
  it("passes when logic files import no I/O modules", () => {
    const t = tree("oc-test", { "src/my-logic.ts": COMPLIANT_LOGIC });
    expect(checkPureIoSeparation(t)).toEqual([]);
  });

  it("fails when a logic file imports node:fs", () => {
    const src = COMPLIANT_LOGIC.replace(
      "export interface",
      'import { readFileSync } from "node:fs";\n\nexport interface',
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkPureIoSeparation(t);
    expect(v).toHaveLength(1);
    expect(v[0].axiom).toBe("pure-io-separation");
    expect(v[0].severity).toBe("error");
    expect(v[0].message).toContain("node:fs");
  });

  it("fails when a logic file imports node:child_process", () => {
    const src = COMPLIANT_LOGIC.replace(
      "export interface",
      'import { execSync } from "node:child_process";\n\nexport interface',
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    expect(checkPureIoSeparation(t)).toHaveLength(1);
  });

  it("fails when index.ts imports node:fs directly", () => {
    const src = COMPLIANT_INDEX.replace(
      'import { processItems }',
      'import { readFileSync } from "node:fs";\nimport { processItems }',
    );
    const t = tree("oc-test", { "src/index.ts": src });
    const v = checkPureIoSeparation(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("Protocol wrapper");
  });

  it("allows logic files to import from shared/ (relative)", () => {
    const src = COMPLIANT_LOGIC.replace(
      "export interface",
      'import { SOMETHING } from "../shared/regex-library.js";\n\nexport interface',
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    expect(checkPureIoSeparation(t)).toEqual([]);
  });
});

// ── Axiom 2: Determinism ─────────────────────────────────────────────────

describe("Axiom 2: determinism", () => {
  it("passes when logic files have no Date.now/Math.random/new Date", () => {
    const t = tree("oc-test", { "src/my-logic.ts": COMPLIANT_LOGIC });
    expect(checkDeterminism(t)).toEqual([]);
  });

  it("fails on Date.now()", () => {
    const src = COMPLIANT_LOGIC.replace(
      "return { result:",
      "const now = Date.now();\n  return { result:",
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkDeterminism(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("Date.now()");
  });

  it("fails on Math.random()", () => {
    const src = COMPLIANT_LOGIC.replace(
      "return { result:",
      "const r = Math.random();\n  return { result:",
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkDeterminism(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("Math.random()");
  });

  it("fails on new Date()", () => {
    const src = COMPLIANT_LOGIC.replace(
      "return { result:",
      "const d = new Date();\n  return { result:",
    );
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkDeterminism(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("new Date()");
  });

  it("does NOT check non-logic files (index.ts can use Date.now)", () => {
    const src = COMPLIANT_INDEX.replace(
      "register(api",
      "const now = Date.now();\n  register(api",
    );
    const t = tree("oc-test", { "src/index.ts": src });
    expect(checkDeterminism(t)).toEqual([]);
  });
});

// ── Axiom 3: Manifest conformance ────────────────────────────────────────

describe("Axiom 3: manifest-conformance", () => {
  it("passes when declared tools match registered tools", () => {
    const t = tree("oc-test", { "src/index.ts": COMPLIANT_INDEX }, COMPLIANT_MANIFEST);
    expect(checkManifestConformance(t)).toEqual([]);
  });

  it("fails when a declared tool is not registered", () => {
    const manifest = { ...COMPLIANT_MANIFEST, contracts: { tools: ["test_tool", "missing_tool"] } };
    const t = tree("oc-test", { "src/index.ts": COMPLIANT_INDEX }, manifest);
    const v = checkManifestConformance(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("missing_tool");
    expect(v[0].message).toContain("not registered");
  });

  it("fails when a registered tool is not declared", () => {
    const manifest = { ...COMPLIANT_MANIFEST, contracts: { tools: [] } };
    const t = tree("oc-test", { "src/index.ts": COMPLIANT_INDEX }, manifest);
    const v = checkManifestConformance(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("test_tool");
    expect(v[0].message).toContain("not declared");
  });

  it("fails when manifest is missing", () => {
    const t = tree("oc-test", { "src/index.ts": COMPLIANT_INDEX }, null);
    const v = checkManifestConformance(t);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("missing");
  });
});

// ── Axiom 4: DFT documentation ───────────────────────────────────────────

describe("Axiom 4: dft-docs", () => {
  it("passes when source files have @dft", () => {
    const t = tree("oc-test", { "src/my-logic.ts": COMPLIANT_LOGIC });
    expect(checkDftDocs(t)).toEqual([]);
  });

  it("passes when source files have @invariants (without @dft)", () => {
    const src = "/**\n * @invariants pure\n */\nexport const x = 1;\n";
    const t = tree("oc-test", { "src/my-logic.ts": src });
    expect(checkDftDocs(t)).toEqual([]);
  });

  it("fails when a source file lacks both @dft and @invariants", () => {
    const src = "export const x = 1;\n";
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkDftDocs(t);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("error");
  });

  it("does NOT check test files", () => {
    const t = tree("oc-test", { "src/my-logic.spec.ts": "export const x = 1;\n" });
    expect(checkDftDocs(t)).toEqual([]);
  });
});

// ── Axiom 5: Mock doubles ────────────────────────────────────────────────

describe("Axiom 5: mock-doubles", () => {
  it("passes when integration tests have no vi.fn()", () => {
    const src = 'import { describe } from "vitest";\ndescribe("x", () => {});\n';
    const t = tree("oc-test", { "tests/integration.spec.ts": src });
    expect(checkMockDoubles(t)).toEqual([]);
  });

  it("warns when integration tests use many vi.fn() without a real double", () => {
    const src = `import { vi } from "vitest";
const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
describe("x", () => {});
`;
    const t = tree("oc-test", { "tests/integration.spec.ts": src });
    const v = checkMockDoubles(t);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warn");
  });

  it("passes when integration tests use vi.fn() but also have a real double", () => {
    const src = `import { vi } from "vitest";
class RealReader implements Reader { read() { return null; } }
const handler = vi.fn();
describe("x", () => {});
`;
    const t = tree("oc-test", { "tests/integration.spec.ts": src });
    expect(checkMockDoubles(t)).toEqual([]);
  });
});

// ── Axiom 6: CheckResult pattern ─────────────────────────────────────────

describe("Axiom 6: check-result", () => {
  it("passes when mutating functions return a report (not void)", () => {
    const t = tree("oc-test", { "src/my-logic.ts": COMPLIANT_LOGIC });
    expect(checkCheckResult(t)).toEqual([]);
  });

  it("warns when a mutating function returns void", () => {
    const src = COMPLIANT_LOGIC + "\nexport function cleanupData(): void {\n  // noop\n}\n";
    const t = tree("oc-test", { "src/my-logic.ts": src });
    const v = checkCheckResult(t);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("warn");
    expect(v[0].message).toContain("cleanupData");
  });

  it("does NOT warn for non-mutating void functions", () => {
    const src = COMPLIANT_LOGIC + "\nexport function getValue(): void {\n  // noop\n}\n";
    const t = tree("oc-test", { "src/my-logic.ts": src });
    expect(checkCheckResult(t)).toEqual([]);
  });
});

// ── Composite validator ──────────────────────────────────────────────────

describe("validatePlugin (composite)", () => {
  it("returns no violations for a fully compliant plugin", () => {
    const t = tree(
      "oc-test",
      {
        "src/my-logic.ts": COMPLIANT_LOGIC,
        "src/index.ts": COMPLIANT_INDEX,
      },
      COMPLIANT_MANIFEST,
    );
    expect(validatePlugin(t)).toEqual([]);
  });

  it("returns violations for a plugin with multiple issues", () => {
    const badLogic = `import { readFileSync } from "node:fs";
const now = Date.now();
export function cleanupData(): void {}
`;
    const badIndex = `import { readFileSync } from "node:fs";
export default { id: "x", name: "x", description: "x", register() {} };
`;
    const t = tree(
      "oc-test",
      { "src/my-logic.ts": badLogic, "src/index.ts": badIndex },
      null,
    );
    const v = validatePlugin(t);
    // At minimum: I/O in logic, determinism, missing manifest, missing dft docs
    expect(v.length).toBeGreaterThanOrEqual(4);
    expect(hasErrors(v)).toBe(true);
  });

  it("hasErrors returns false for warn-only violations", () => {
    const warns: Violation[] = [{ axiom: "test", message: "warn", severity: "warn" }];
    expect(hasErrors(warns)).toBe(false);
  });
});

// ── Helper function tests ────────────────────────────────────────────────

describe("extractImports", () => {
  it("extracts module specifiers from import statements", () => {
    const src = `import { x } from "node:fs";
import type { Y } from "./types.js";
import { z } from "../shared/regex-library.js";
`;
    expect(extractImports(src)).toEqual(["node:fs", "./types.js", "../shared/regex-library.js"]);
  });
});

describe("extractRegisteredTools", () => {
  it("extracts tool names from registerTool calls", () => {
    const src = `api.registerTool({ name: "health", description: "x", parameters: {}, async execute() {} });
api.registerTool({ name: "cleanup", description: "y", parameters: {}, async execute() {} });
`;
    expect(extractRegisteredTools(src)).toEqual(["health", "cleanup"]);
  });
});

describe("extractRegisteredHooks", () => {
  it("extracts single-string hook events", () => {
    const src = `api.registerHook("session_end", async () => {});
api.registerHook("after_compaction", async () => {});
`;
    expect(extractRegisteredHooks(src)).toEqual(["session_end", "after_compaction"]);
  });

  it("extracts array-form hook events", () => {
    const src = `api.registerHook(["session_start", "session_end"], async () => {});
`;
    expect(extractRegisteredHooks(src)).toEqual(["session_start", "session_end"]);
  });

  it("extracts api.on() hook events", () => {
    const src = `api.on("model_call_started", async () => {});
api.on("model_call_ended", async () => {});
`;
    expect(extractRegisteredHooks(src)).toEqual(["model_call_started", "model_call_ended"]);
  });
});

// ── Strict Structural Hygiene & Test Pyramid Checks ──────────────────────

describe("Strict Phosphene Hygiene Checks", () => {
  it("checkManifestConformance enforces bidirectional hooks when checkHooks is true", () => {
    const t = tree(
      "oc-test",
      {
        "src/index.ts": `api.on("gateway_start", async () => {});
api.on("undeclared_hook", async () => {});`,
      },
      { id: "oc-test", name: "OcTest", description: "t", contracts: { tools: [], hooks: ["gateway_start", "missing_hook"] } },
    );
    const v = checkManifestConformance(t, { checkHooks: true });
    expect(v.map((x) => x.message)).toEqual([
      expect.stringContaining("missing_hook"),
      expect.stringContaining("undeclared_hook"),
    ]);
  });

  it("checkReachability flags dead/unreachable source files", () => {
    const t = tree("oc-test", {
      "src/index.ts": `import { live } from "./live.js"; export const x = live;`,
      "src/live.ts": `export const live = 1;`,
      "src/dead.ts": `export const dead = 2;`,
    });
    const v = checkReachability(t);
    expect(v).toHaveLength(1);
    expect(v[0].axiom).toBe("reachability");
    expect(v[0].file).toBe("src/dead.ts");
  });

  it("checkNoInlineRegex flags inline regexes outside regex utils", () => {
    const t = tree("oc-test", {
      "src/parser-logic.ts": `export function clean(s: string) { return s.replace(/\\s+/g, " "); }`,
      "src/my-regex-utils.ts": `export const WS = /\\s+/g;`,
    });
    const v = checkNoInlineRegex(t);
    expect(v).toHaveLength(1);
    expect(v[0].axiom).toBe("no-inline-regex");
    expect(v[0].file).toBe("src/parser-logic.ts");
  });

  it("checkNoEmptyCatch flags silent catch {} blocks", () => {
    const t = tree("oc-test", {
      "src/index.ts": `try { run(); } catch {}`,
    });
    const v = checkNoEmptyCatch(t);
    expect(v).toHaveLength(1);
    expect(v[0].axiom).toBe("no-empty-catch");
  });

  it("checkNoTypeErasure flags any and as never seams", () => {
    const t = tree("oc-test", {
      "src/index.ts": `const x = (foo as any).bar;`,
    });
    const v = checkNoTypeErasure(t);
    expect(v).toHaveLength(1);
    expect(v[0].axiom).toBe("no-type-erasure");
  });

  it("checkUnitSizeCeilings flags oversized files and functions", () => {
    const longBody = Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const t = tree("oc-test", {
      "src/big.ts": `export function tooLong() {\n${longBody}\n  return 0;\n}\n`,
    });
    const v = checkUnitSizeCeilings(t, { maxFileLines: 10, maxFnLines: 10 });
    expect(v.map((x) => x.axiom)).toEqual(["small-files", "small-units"]);
  });

  it("checkTestPyramid enforces 1:1 slice unit specs plus integration and manifest specs", () => {
    const t = tree("oc-test", {
      "src/slices/energy/logic.ts": `export const step = () => 1;`,
    });
    const v = checkTestPyramid(t);
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.axiom === "test-pyramid")).toBe(true);
  });

  it("validatePluginStrict passes on a clean modular slice plugin", () => {
    const t = tree(
      "oc-clean",
      {
        "src/index.ts": `/** @dft root */\nimport { bindEnergy } from "./slices/energy/slice.js";\nexport default { id: "oc-clean", register(api: unknown) { bindEnergy(api); } };\n`,
        "src/slices/energy/state.ts": `/** @dft state */\nexport interface EnergyState { value: number; }\nexport function createEnergyState(): EnergyState { return { value: 100 }; }\n`,
        "src/slices/energy/logic.ts": `/** @dft logic */\nimport type { EnergyState } from "./state.js";\nexport function drain(s: EnergyState, cost: number): { next: EnergyState } { return { next: { value: s.value - cost } }; }\n`,
        "src/slices/energy/slice.ts": `/** @dft slice */\nimport { createEnergyState } from "./state.js";\nimport { drain } from "./logic.js";\nexport function bindEnergy(api: { on: Function; registerTool: Function }) {\n  let s = createEnergyState();\n  api.on("before_tool_call", () => { s = drain(s, 1).next; });\n  api.registerTool({ name: "energy_health", execute: async () => s });\n}\n`,
        "src/slices/energy/tests/logic.spec.ts": `// unit test`,
        "tests/integration.spec.ts": `// integration test`,
        "tests/manifest.spec.ts": `// manifest test`,
      },
      { id: "oc-clean", name: "OcClean", description: "clean", contracts: { tools: ["energy_health"], hooks: ["before_tool_call"] } },
    );
    expect(validatePluginStrict(t)).toEqual([]);
  });
});
