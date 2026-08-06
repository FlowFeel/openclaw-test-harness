/**
 * Foundry CI spec — validates all 11 plugins against the six DFT axioms.
 *
 * @why
 * The foundry CLI (`npx tsx src/foundry/cli.ts validate`) is a local check.
 * A P0 violation (node:fs import in oc-compaction-helper) shipped to main
 * because no CI step ran the foundry. This spec runs the pure validator
 * in-process (no subprocess) inside the existing vitest step — so DFT
 * violations fail CI even if the dedicated "Foundry validation" step is
 * removed. Defense-in-depth: the CI step catches it fast (~3s), this spec
 * catches it redundantly in the test report.
 *
 * @dft
 * - A5 (mock-doubles): reads real plugin source from disk — no mocks.
 * - A6 (check-result): the validator returns Violation[] — the test asserts
 *   the list is empty, and prints every violation if it isn't.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { validatePlugin, hasErrors } from "../../src/foundry/validate-logic.js";
import type { PluginTree, PluginManifest } from "../../src/foundry/types.js";

const __dirname = new URL(".", import.meta.url).pathname;
const pluginsDir = resolve(__dirname, "..", "..", "src", "plugins");

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
      } else if (entry.endsWith(".ts") || entry.endsWith(".json")) {
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

/** List all plugin directories (oc-*). */
function listPluginDirs(): string[] {
  return readdirSync(pluginsDir)
    .filter((name) => name.startsWith("oc-"))
    .filter((name) => {
      const dir = join(pluginsDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "src", "index.ts"));
    })
    .map((name) => join(pluginsDir, name));
}

describe("Foundry CI: all plugins pass the six DFT axioms", () => {
  const pluginDirs = listPluginDirs();

  it("found at least 11 plugins to validate", () => {
    expect(pluginDirs.length).toBeGreaterThanOrEqual(11);
  });

  // One test per plugin — a failure names the plugin in the test title.
  for (const pluginDir of pluginDirs) {
    const name = pluginDir.split("/").pop()!;

    it(`${name}: zero DFT violations`, () => {
      const tree = readPluginTree(pluginDir);
      const violations = validatePlugin(tree);

      if (hasErrors(violations)) {
        // Print every violation so the CI log shows exactly what's wrong
        const details = violations
          .map(
            (v) =>
              `  ${v.severity === "error" ? "✗" : "⚠"} [${v.axiom}] ${v.file ?? ""}: ${v.message}`
          )
          .join("\n");
        throw new Error(
          `${name} has ${violations.length} DFT violation(s):\n${details}`
        );
      }

      // Warnings are advisory — they don't fail CI, but we assert none exist
      // to keep the suite clean. If a warning is expected, suppress it here.
      const warnings = violations.filter((v) => v.severity === "warn");
      expect(warnings).toEqual([]);
    });
  }
});
