/**
 * Plugin bundle smoke test — verifies each dist/index.js loads and exports
 * a valid PluginDefinition.
 *
 * @why
 * The build step (scripts/build-plugins.mjs) bundles each plugin's src/index.ts
 * + shared/ dependencies into a self-contained dist/index.js. This test loads
 * each bundle and verifies it exports a valid plugin entry — the same contract
 * OC's plugin loader checks (resolveRegister in setup-registry.ts).
 *
 * This catches:
 * - Missing shared/ imports (B2 — the original blocker)
 * - Broken default export (OC checks mod.default ?? mod)
 * - Missing register function (OC calls mod.register(api, config))
 * - Missing id (OC uses the id for plugin registration)
 *
 * @dft
 * - A5: loads real built artifacts, not mocks
 * - This is a packaging test, not a logic test — DFT axioms A1/A2 don't apply
 */
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pluginsDir = resolve(__dirname, "..", "..", "src", "plugins");

function listBundledPlugins(): Array<{ name: string; path: string }> {
  return readdirSync(pluginsDir)
    .filter((name) => name.startsWith("oc-"))
    .filter((name) => {
      const distPath = join(pluginsDir, name, "dist", "index.js");
      return existsSync(distPath);
    })
    .map((name) => ({
      name,
      path: join(pluginsDir, name, "dist", "index.js"),
    }));
}

const bundledPlugins = listBundledPlugins();

describe("plugin bundle smoke test (dist/index.js)", () => {
  // Ensure the build ran — if dist/ doesn't exist, the build step was skipped
  it("at least one plugin has a dist/index.js bundle", () => {
    expect(bundledPlugins.length).toBeGreaterThan(0);
  });

  for (const { name, path } of bundledPlugins) {
    describe(`${name} bundle`, () => {
      it("loads without error (no missing shared/ imports)", async () => {
        // Dynamic import of the built bundle — if shared/ imports are broken,
        // this throws "Cannot find module"
        const mod = await import(pathToFileURL(path).href);
        expect(mod).toBeDefined();
      });

      it("exports a default PluginDefinition with id + register", async () => {
        const mod = await import(pathToFileURL(path).href);
        // OC checks mod.default ?? mod (setup-registry.ts:293)
        const def = mod.default ?? mod;
        expect(def).toBeDefined();
        expect(typeof def).toBe("object");
        expect(def.id).toBeDefined();
        expect(typeof def.id).toBe("string");
        expect(def.register).toBeDefined();
        expect(typeof def.register).toBe("function");
      });

      it("id matches the manifest id", async () => {
        const mod = await import(pathToFileURL(path).href);
        const def = mod.default ?? mod;
        // Read the manifest to cross-check
        const manifestPath = resolve(path, "..", "..", "openclaw.plugin.json");
        const manifest = JSON.parse(
          await readFile(manifestPath),
        );
        expect(def.id).toBe(manifest.id);
      });
    });
  }
});

// Lazy import to avoid top-level await issues in some runners
async function readFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(path, "utf8");
}
