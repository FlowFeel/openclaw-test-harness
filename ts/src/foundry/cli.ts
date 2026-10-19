#!/usr/bin/env node
/**
 * Foundry CLI — the plugin foundry command interface.
 *
 * @behavior
 * Dispatches three commands:
 *   foundry new <name> [--hooks H1,H2] [--tools T1,T2] [--desc "..."]
 *       Scaffolds a new plugin from the DFT-compliant templates.
 *   foundry validate [<plugin-dir>]
 *       Checks a plugin against the six phosphene DFT axioms.
 *   foundry test [<plugin-dir>]
 *       Runs the plugin's test pyramid (unit → integration).
 *
 * @invariants
 * - The CLI is thin I/O wiring: it parses argv, reads/writes files, and
 *   delegates ALL logic to the pure seams (scaffold.ts, validate-logic.ts).
 * - No business logic here — if you're adding logic, add it to a pure seam.
 *
 * @dft
 * - The pure seams (scaffold.ts, validate-logic.ts) are tested separately.
 * - The CLI is integration-tested by running it as a subprocess.
 */

import { scaffoldPlugin } from "./scaffold.js";
import { validatePlugin, hasErrors } from "./validate-logic.js";
import type { PluginTree, PluginManifest } from "./types.js";
import { safeLog, safeError } from "../plugins/shared/logger-utils.ts";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execSync } from "node:child_process";

// ── argv parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  name?: string;
  hooks: string[];
  tools: string[];
  desc?: string;
  pluginDir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? "";
  const rest = args.slice(1);

  const parsed: ParsedArgs = { command, hooks: [], tools: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--hooks":
        if (rest[i + 1]) parsed.hooks = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--tools":
        if (rest[i + 1]) parsed.tools = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--desc":
        if (rest[i + 1]) parsed.desc = rest[++i];
        break;
      default:
        if (!arg.startsWith("--")) {
          parsed.name = arg;
          parsed.pluginDir = arg;
        }
        break;
    }
  }

  return parsed;
}

// ── Command: new ─────────────────────────────────────────────────────────

function cmdNew(args: ParsedArgs): void {
  if (!args.name) {
    safeError("Usage: foundry new <name> [--hooks H1,H2] [--tools T1,T2] [--desc \"...\"]");
    process.exit(1);
  }

  const pluginDir = resolve("src/plugins", args.name);
  if (existsSync(pluginDir)) {
    safeError(`Plugin already exists: ${pluginDir}`);
    process.exit(1);
  }

  const files = scaffoldPlugin({
    name: args.name,
    hooks: args.hooks,
    tools: args.tools,
    description: args.desc,
  });

  for (const [relPath, content] of files) {
    const fullPath = join(pluginDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }

  safeLog(`✓ Created plugin: ${args.name}`);
  safeLog(`  Location: ${relative(process.cwd(), pluginDir)}`);
  safeLog(`  Files: ${files.size}`);
  safeLog(`  Hooks: ${args.hooks.length > 0 ? args.hooks.join(", ") : "(none)"}`);
  safeLog(`  Tools: ${args.tools.length > 0 ? args.tools.join(", ") : "(none)"}`);
  safeLog("");
  safeLog("Next steps:");
  safeLog(`  cd ${relative(process.cwd(), pluginDir)}`);
  safeLog("  foundry validate .");
  safeLog("  foundry test .");
}

// ── Command: validate ────────────────────────────────────────────────────

/** Read a plugin directory into a PluginTree (in-memory). */
function readPluginTree(pluginDir: string): PluginTree {
  const absDir = resolve(pluginDir);
  if (!existsSync(absDir)) {
    safeError(`Plugin directory not found: ${absDir}`);
    process.exit(1);
  }

  const files = new Map<string, string>();

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
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

  // Parse the manifest.
  let manifest: PluginManifest | null = null;
  const manifestPath = "openclaw.plugin.json";
  if (files.has(manifestPath)) {
    try {
      manifest = JSON.parse(files.get(manifestPath)!);
    } catch {
      manifest = null;
    }
  }

  const name = relative(resolve(absDir, ".."), absDir);

  return { name, manifest, files };
}

function cmdValidate(args: ParsedArgs): void {
  const pluginDir = args.pluginDir ?? ".";
  const tree = readPluginTree(pluginDir);
  const violations = validatePlugin(tree);

  if (violations.length === 0) {
    safeLog(`✓ ${tree.name}: all six DFT axioms pass.`);
    process.exit(0);
  }

  const errors = violations.filter((v) => v.severity === "error");
  const warns = violations.filter((v) => v.severity === "warn");

  for (const v of violations) {
    const icon = v.severity === "error" ? "✗" : "⚠";
    const loc = v.file ? ` ${v.file}:` : "";
    safeLog(`${icon} [${v.axiom}]${loc} ${v.message}`);
  }

  safeLog("");
  safeLog(`${errors.length} error(s), ${warns.length} warning(s)`);

  process.exit(hasErrors(violations) ? 1 : 0);
}

// ── Command: test ────────────────────────────────────────────────────────

function cmdTest(args: ParsedArgs): void {
  const pluginDir = args.pluginDir ?? ".";
  const absDir = resolve(pluginDir);

  // Run vitest for the plugin's test files.
  const testPattern = join(absDir, "tests/**/*.spec.ts");
  try {
    execSync(`npx vitest run "${testPattern}"`, { stdio: "inherit", cwd: process.cwd() });
  } catch {
    process.exit(1);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "new":
      cmdNew(args);
      break;
    case "validate":
      cmdValidate(args);
      break;
    case "test":
      cmdTest(args);
      break;
    default:
      safeError("Usage: foundry <new|validate|test> [options]");
      safeError("");
      safeError("Commands:");
      safeError("  new <name> [--hooks H1,H2] [--tools T1,T2] [--desc \"...\"]  Scaffold a plugin");
      safeError("  validate [<dir>]                                              Check DFT axioms");
      safeError("  test [<dir>]                                                  Run plugin tests");
      process.exit(1);
  }
}

main();
