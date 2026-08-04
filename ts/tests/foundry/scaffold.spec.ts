/**
 * Foundry scaffolder — pure logic unit tests.
 *
 * @dft
 * - Pure: inline params, zero fixtures, no filesystem.
 * - The round-trip test proves generated plugins PASS validatePlugin.
 * - Deterministic: same params → same file map.
 */

import { describe, it, expect } from "vitest";
import {
  scaffoldPlugin,
  toPascalCase,
  toCamelCase,
  shortName,
  logicModuleName,
} from "../../src/foundry/scaffold.js";
import { validatePlugin, hasErrors } from "../../src/foundry/validate-logic.js";
import type { PluginTree, PluginManifest } from "../../src/foundry/types.js";

// ── Helper: convert GeneratedFiles to a PluginTree for validation ────────

function treeFromFiles(
  name: string,
  files: Map<string, string>,
): PluginTree {
  let manifest: PluginManifest | null = null;
  if (files.has("openclaw.plugin.json")) {
    manifest = JSON.parse(files.get("openclaw.plugin.json")!);
  }
  return { name, manifest, files };
}

// ── Name helpers ─────────────────────────────────────────────────────────

describe("name helpers", () => {
  it("toPascalCase converts kebab-case to PascalCase", () => {
    expect(toPascalCase("oc-session-guard")).toBe("OcSessionGuard");
    expect(toPascalCase("my-plugin")).toBe("MyPlugin");
    expect(toPascalCase("single")).toBe("Single");
  });

  it("toCamelCase converts kebab-case to camelCase", () => {
    expect(toCamelCase("oc-session-guard")).toBe("ocSessionGuard");
    expect(toCamelCase("my-plugin")).toBe("myPlugin");
  });

  it("shortName strips the oc- prefix", () => {
    expect(shortName("oc-session-guard")).toBe("session-guard");
    expect(shortName("my-plugin")).toBe("my-plugin");
  });

  it("logicModuleName produces the logic file name", () => {
    expect(logicModuleName("oc-session-guard")).toBe("session-guard-logic");
    expect(logicModuleName("my-plugin")).toBe("my-plugin-logic");
  });
});

// ── File generation ──────────────────────────────────────────────────────

describe("scaffoldPlugin file generation", () => {
  it("generates a manifest with the correct id and contracts", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end", "after_compaction"],
      tools: ["health", "cleanup"],
    });
    const manifest = JSON.parse(files.get("openclaw.plugin.json")!);
    expect(manifest.id).toBe("oc-test-plugin");
    expect(manifest.contracts.tools).toEqual(["health", "cleanup"]);
    expect(manifest.contracts.hooks).toEqual(["session_end", "after_compaction"]);
  });

  it("generates a logic file with pure seam and @dft docblock", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: [],
      tools: ["health"],
    });
    const logic = files.get("src/test-plugin-logic.ts")!;
    expect(logic).toContain("@dft");
    expect(logic).toContain("@invariants");
    expect(logic).toContain("processOcTestPlugin");
    // Check code (not comments) for Date.now — strip block comments first
    const code = logic.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bDate\.now\s*\(/);
    expect(code).not.toContain("node:fs");
  });

  it("generates an I/O wrapper when tools are declared", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: [],
      tools: ["health"],
    });
    expect(files.has("src/test-plugin-io.ts")).toBe(true);
    const io = files.get("src/test-plugin-io.ts")!;
    expect(io).toContain("OcTestPluginReader");
    expect(io).toContain("OcTestPluginWriter");
  });

  it("does NOT generate an I/O wrapper when no tools are declared", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end"],
      tools: [],
    });
    expect(files.has("src/test-plugin-io.ts")).toBe(false);
  });

  it("generates index.ts with hook and tool registrations", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end", "after_compaction"],
      tools: ["health", "cleanup"],
    });
    const index = files.get("src/index.ts")!;
    expect(index).toContain('registerHook("session_end"');
    expect(index).toContain('registerHook("after_compaction"');
    expect(index).toContain('name: "health"');
    expect(index).toContain('name: "cleanup"');
    expect(index).not.toContain('import { readFileSync }'); // no direct node:fs
  });

  it("generates test files (manifest, unit, integration)", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end"],
      tools: ["health"],
    });
    expect(files.has("tests/manifest.spec.ts")).toBe(true);
    expect(files.has("tests/test-plugin-logic.spec.ts")).toBe(true);
    expect(files.has("tests/integration.spec.ts")).toBe(true);
  });

  it("generates the correct number of files", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end"],
      tools: ["health"],
    });
    // manifest + package.json + logic + io + index + 3 tests = 8
    expect(files.size).toBe(8);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────

describe("scaffoldPlugin determinism", () => {
  it("produces identical output for identical params", () => {
    const params = { name: "oc-test", hooks: ["session_end"], tools: ["health"] };
    const a = scaffoldPlugin(params);
    const b = scaffoldPlugin(params);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

// ── THE ROUND-TRIP: generated plugins pass the validator ─────────────────
// This is the core DFT guarantee: the templates ARE the codified standard,
// so their output must pass the validator by construction.

describe("round-trip: generated plugins pass validatePlugin", () => {
  it("a full plugin (hooks + tools) passes with zero errors", () => {
    const files = scaffoldPlugin({
      name: "oc-test-plugin",
      hooks: ["session_end", "after_compaction"],
      tools: ["health", "cleanup"],
    });
    const tree = treeFromFiles("oc-test-plugin", files);
    const violations = validatePlugin(tree);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors).toEqual([]);
  });

  it("a hooks-only plugin (no tools) passes with zero errors", () => {
    const files = scaffoldPlugin({
      name: "oc-hooks-only",
      hooks: ["session_end"],
      tools: [],
    });
    const tree = treeFromFiles("oc-hooks-only", files);
    const violations = validatePlugin(tree);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors).toEqual([]);
  });

  it("a tools-only plugin (no hooks) passes with zero errors", () => {
    const files = scaffoldPlugin({
      name: "oc-tools-only",
      hooks: [],
      tools: ["my_tool"],
    });
    const tree = treeFromFiles("oc-tools-only", files);
    const violations = validatePlugin(tree);
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors).toEqual([]);
  });
});
