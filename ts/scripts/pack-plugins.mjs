/**
 * Plugin packaging script: packages each OC plugin into a distributable .tgz archive.
 *
 * @why
 * Track B (The Plugin Suite) distribution model:
 * OpenClaw supports installing plugins from local directory or from an archive
 * (`openclaw plugins install <tarball>`). For agents and external consumers,
 * distributing self-contained .tgz archives with their SHA256 checksums enables
 * reproducible offline installation, CI verification, and release uploads.
 *
 * @process
 * 1. Checks that dist/index.js exists for each plugin (built via build-plugins.mjs).
 * 2. Packs each plugin using npm pack into ts/dist-plugins/.
 * 3. Calculates SHA256 hash for each generated archive.
 * 4. Emits ts/dist-plugins/plugins-manifest.json describing the entire suite.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const tsRoot = resolve(__dirname, "..");
const pluginsDir = join(tsRoot, "src", "plugins");
const outDir = join(tsRoot, "dist-plugins");

function listPluginDirs() {
  return readdirSync(pluginsDir)
    .filter((name) => name.startsWith("oc-"))
    .filter((name) => {
      const dir = join(pluginsDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "package.json"));
    })
    .sort()
    .map((name) => join(pluginsDir, name));
}

function sha256File(filePath) {
  const fileBuffer = readFileSync(filePath);
  return createHash("sha256").update(fileBuffer).digest("hex");
}

async function main() {
  const pluginDirs = listPluginDirs();
  console.log(`Packaging ${pluginDirs.length} OpenClaw plugins into ${outDir}...\n`);

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const catalog = {
    generatedAt: new Date().toISOString(),
    pluginsCount: pluginDirs.length,
    plugins: [],
  };

  for (const pluginDir of pluginDirs) {
    const pluginFolder = pluginDir.split("/").pop();
    const pkgJsonPath = join(pluginDir, "package.json");
    const manifestJsonPath = join(pluginDir, "openclaw.plugin.json");
    const distIndexPath = join(pluginDir, "dist", "index.js");

    if (!existsSync(distIndexPath)) {
      console.warn(`  [WARN] ${pluginFolder} is missing dist/index.js! Building plugins first is recommended.`);
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const pluginManifest = existsSync(manifestJsonPath)
      ? JSON.parse(readFileSync(manifestJsonPath, "utf8"))
      : {};

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const packOutput = execFileSync(
      npmCmd,
      ["pack", "--pack-destination", outDir, "--json"],
      { cwd: pluginDir, encoding: "utf8" }
    );

    const packDetails = JSON.parse(packOutput)[0];
    const archivePath = join(outDir, packDetails.filename);
    const archiveSha256 = sha256File(archivePath);

    const entry = {
      id: pluginManifest.id ?? pkgJson.name,
      name: pkgJson.name,
      version: pkgJson.version,
      filename: packDetails.filename,
      sizeBytes: packDetails.size,
      sha256: archiveSha256,
      shasum: packDetails.shasum,
      integrity: packDetails.integrity,
      description: pluginManifest.description ?? pkgJson.description ?? "",
      contracts: pluginManifest.contracts ?? {},
      openclaw: pkgJson.openclaw ?? {},
    };

    catalog.plugins.push(entry);
    console.log(`  ✓ ${entry.id.padEnd(28)} → ${entry.filename} (${(entry.sizeBytes / 1024).toFixed(1)} KB)`);
  }

  const catalogPath = join(outDir, "plugins-manifest.json");
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

  console.log(`\nCatalog written to ${catalogPath}`);
  console.log(`All ${catalog.pluginsCount} plugins packaged successfully.`);
}

main().catch((err) => {
  console.error("Packaging failed:", err);
  process.exit(1);
});
