/**
 * Build script: bundles each OC plugin into a self-contained dist/index.js.
 *
 * @why
 * Blocker B2 from the ship review: 10 of 11 plugins import pure logic from
 * `../../shared/*.js`. When OC installs a plugin individually via
 * `openclaw plugins install`, it copies only the plugin directory — `shared/`
 * is not included. The import resolves to a nonexistent path. The plugin
 * crashes on load.
 *
 * Three fix options were evaluated (see docs/ship-review.md):
 *   A: Bundle shared/ into each plugin at build time (this script)
 *   B: Publish shared/ as an npm package
 *   C: Install as a suite via plugins.load.paths
 *
 * Option B is dead: OC's installer only runs `npm install` for plugin deps
 * when `installPolicyRequest.kind === "plugin-archive"` (see install-package.ts
 * line 280-283). For directory installs (`openclaw plugins install ./dir`),
 * `shouldInstallRuntimeDeps` is false. A published `@flowfeel/oc-plugin-shared`
 * dependency would never get installed.
 *
 * Option C is a development stopgap, not a distribution model. It requires
 * cloning the repo and pointing OC at the source directory. It doesn't support
 * individual plugin install.
 *
 * Option A is the only choice that works for all install methods (directory,
 * archive, plugins.load.paths). Each plugin's dist/index.js is self-contained:
 * shared/ logic is bundled in, node: builtins are external. No network
 * dependency, no npm publishing, no version coordination overhead. This is the
 * standard OC plugin pattern (the install error message itself suggests
 * `["./dist/index.js"]`).
 *
 * @cost
 * - Build time: ~2-5s for 11 plugins (esbuild is fast).
 * - Bundle size: ~20-50KB per plugin (shared/ is 105KB total source, tree-shaken
 *   per plugin). 10 plugins × ~40KB = ~400KB total. Negligible.
 * - CI: adds a build step + smoke test (~6s). Catches the entire class of
 *   packaging bugs (B1/B2/H1/M1) that source-only testing misses.
 *
 * @dft
 * - A1: build script is infrastructure, not plugin logic — no DFT axiom applies.
 * - The smoke test (tests/spec/plugin-bundle.spec.ts) verifies each bundle
 *   loads and exports a valid PluginDefinition (has id + register).
 */
import { build } from "esbuild";
import { readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pluginsDir = resolve(__dirname, "..", "src", "plugins");

function listPluginDirs() {
  return readdirSync(pluginsDir)
    .filter((name) => name.startsWith("oc-"))
    .filter((name) => {
      const dir = join(pluginsDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "src", "index.ts"));
    })
    .map((name) => join(pluginsDir, name));
}

async function buildPlugin(pluginDir) {
  const pluginName = pluginDir.split("/").pop();
  const entryPoint = join(pluginDir, "src", "index.ts");
  const outDir = join(pluginDir, "dist");

  // Clean previous build
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }

  console.log(`  bundling ${pluginName}...`);

  // Main entry point: src/index.ts → dist/index.js
  const entryPoints = [entryPoint];
  const entryOuts = [join(outDir, "index.js")];

  // Additional entry points for plugins that spawn separate processes/workers.
  // These get bundled to their own dist/*.js files.
  const extraEntries = ["sidecar-server.ts", "worker-entry.ts"];
  for (const extra of extraEntries) {
    const extraPath = join(pluginDir, "src", extra);
    if (existsSync(extraPath)) {
      entryPoints.push(extraPath);
      const extraOut = extra.replace(/\.ts$/, ".js");
      entryOuts.push(join(outDir, extraOut));
      console.log(`    + ${extra} → dist/${extraOut}`);
    }
  }

  await build({
    entryPoints,
    bundle: true,
    outdir: outDir,
    outExtension: { ".js": ".js" },
    platform: "node",
    format: "esm",
    target: "node22",
    // Node builtins are external — they resolve from the runtime, not the bundle
    packages: "external",
    // Tree-shake unused shared/ exports (each plugin only gets what it imports)
    treeShaking: true,
    // Generate source maps for debuggability
    sourcemap: true,
    // Keep names for readable stack traces
    keepNames: true,
    // Log level
    logLevel: "info",
  });
}

async function main() {
  const pluginDirs = listPluginDirs();
  console.log(`Building ${pluginDirs.length} plugins...`);

  for (const pluginDir of pluginDirs) {
    await buildPlugin(pluginDir);
  }

  console.log(`\nDone. ${pluginDirs.length} plugins bundled to dist/index.js`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
