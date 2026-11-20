/**
 * Foundry CI spec — validates ALL v1 plugins AND all 4 v2 domain engines
 * against the six DFT axioms + strict structural hygiene & test-pyramid gates.
 *
 * @why
 * Runs the pure Foundry validator in-process inside the CI vitest step so DFT
 * violations fail CI even if the standalone `validate:foundry` CLI step is
 * bypassed. Enforces bidirectional hook conformance across all 20 plugins and
 * strict reachability / regex / empty-catch / type-erasure / test-pyramid
 * gates on all 4 v2 domain engines.
 *
 * @dft
 * - A5 (mock-doubles): reads real plugin source from disk — no mocks.
 * - A6 (check-result): the validator returns Violation[] — the test asserts
 *   the list is empty, and prints every violation if it isn't.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  validatePlugin,
  hasErrors,
  checkReachability,
  checkNoInlineRegex,
  checkNoEmptyCatch,
  checkNoTypeErasure,
  checkTestPyramid,
} from "../../src/foundry/validate-logic.js";
import type { PluginTree, PluginManifest, Violation } from "../../src/foundry/types.js";

const __dirname = new URL(".", import.meta.url).pathname;
const pluginsDir = resolve(__dirname, "..", "..", "src", "plugins");
const v2PluginsDir = resolve(pluginsDir, "v2");

/** Read a plugin directory into a PluginTree (mirrors cli.ts readPluginTree). */
function readPluginTree(pluginDir: string): PluginTree {
  const absDir = resolve(pluginDir);
  const files = new Map<string, string>();

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".json")) {
        const rel = relative(absDir, full);
        files.set(rel, readFileSync(full, "utf8"));
      }
    }
  }
  walk(absDir);

  let manifest: PluginManifest | null = null;
  if (files.has("openclaw.plugin.json")) {
    try {
      manifest = JSON.parse(files.get("openclaw.plugin.json")!);
    } catch {
      manifest = null;
    }
  }

  const name = relative(resolve(absDir, ".."), absDir);
  return { name, manifest, files };
}

function listPluginDirs(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .sort()
    .filter((name) => name.startsWith("oc-"))
    .filter((name) => {
      const dir = join(rootDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "src", "index.ts"));
    })
    .map((name) => join(rootDir, name));
}

function formatViolations(name: string, violations: Violation[]): string {
  const details = violations
    .map(
      (v) =>
        `  ${v.severity === "error" ? "✗" : "⚠"} [${v.axiom}] ${v.file ?? ""}: ${v.message}`
    )
    .join("\n");
  return `${name} has ${violations.length} DFT violation(s):\n${details}`;
}

describe("Foundry CI: all legacy v1 plugins pass DFT axioms + bidirectional hook contracts", () => {
  const v1Dirs = listPluginDirs(pluginsDir);

  it("found at least 11 v1 plugins to validate", () => {
    expect(v1Dirs.length).toBeGreaterThanOrEqual(11);
  });

  for (const pluginDir of v1Dirs) {
    const name = pluginDir.split("/").pop()!;

    it(`v1/${name}: zero DFT or manifest-hook violations`, () => {
      const tree = readPluginTree(pluginDir);
      const violations = validatePlugin(tree, { checkHooks: true });

      if (hasErrors(violations)) {
        throw new Error(formatViolations(`v1/${name}`, violations));
      }

      const warnings = violations.filter((v) => v.severity === "warn");
      expect(warnings).toEqual([]);
    });
  }
});

describe("Foundry CI: all 4 v2 domain engines pass strict DFT + structural hygiene + test pyramid", () => {
  const v2Dirs = listPluginDirs(v2PluginsDir);

  it("found all 4 v2 domain engines", () => {
    expect(v2Dirs.length).toBe(4);
  });

  for (const pluginDir of v2Dirs) {
    const name = pluginDir.split("/").pop()!;

    it(`v2/${name}: zero DFT, hook, reachability, regex, empty-catch, type-erasure, or pyramid violations`, () => {
      const tree = readPluginTree(pluginDir);
      const violations: Violation[] = [
        ...validatePlugin(tree, { checkHooks: true }),
        ...checkReachability(tree),
        ...checkNoInlineRegex(tree),
        ...checkNoEmptyCatch(tree),
        ...checkNoTypeErasure(tree),
        ...checkTestPyramid(tree),
      ];

      if (hasErrors(violations)) {
        throw new Error(formatViolations(`v2/${name}`, violations));
      }

      const warnings = violations.filter((v) => v.severity === "warn");
      expect(warnings).toEqual([]);
    });
  }
});
