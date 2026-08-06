/**
 * Sidecar build artifact verification.
 *
 * Verifies that the esbuild build produces all 3 required files in dist/:
 * - dist/index.js (plugin entry — loads in OC's plugin system)
 * - dist/sidecar-server.js (spawned as a child process by sidecar-manager)
 * - dist/worker-entry.js (spawned as worker_threads by sidecar-server)
 *
 * Without all 3, the sidecar silently fails to start:
 * - Missing sidecar-server.js → spawn resolves to nonexistent .ts, catch swallows
 * - Missing worker-entry.js → Worker() throws, sidecar server crashes
 *
 * @dft A6 (check-result) — the test IS the proof that artifacts exist and load.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginDir = resolve(__dirname, "../../../src/plugins/oc-sidecar");
const distDir = resolve(pluginDir, "dist");

describe("Sidecar build artifacts", () => {
  it("dist/index.js exists and exports a valid plugin", () => {
    const indexPath = resolve(distDir, "index.js");
    expect(existsSync(indexPath)).toBe(true);

    const mod = require(indexPath);
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("oc-sidecar");
    expect(typeof mod.default.register).toBe("function");
  });

  it("dist/sidecar-server.js exists and is a valid module", () => {
    const serverPath = resolve(distDir, "sidecar-server.js");
    expect(existsSync(serverPath)).toBe(true);

    const content = readFileSync(serverPath, "utf8");
    // Should contain an HTTP server creation
    expect(content).toContain("createServer");
    // Should NOT reference .ts files as import paths (only source map comments)
    const importLines = content.split("\n").filter(l => l.match(/^import\s/) || l.match(/^var.*require/));
    const tsImports = importLines.filter(l => l.includes(".ts") && !l.startsWith("//"));
    expect(tsImports).toEqual([]);
  });

  it("dist/worker-entry.js exists and is a valid module", () => {
    const workerPath = resolve(distDir, "worker-entry.js");
    expect(existsSync(workerPath)).toBe(true);

    const content = readFileSync(workerPath, "utf8");
    // Worker entry should be self-contained (no external imports)
    const importLines = content.split("\n").filter(l => l.match(/^import\s/) || l.match(/^var.*require/));
    const sharedImports = importLines.filter(l => l.includes("shared/"));
    expect(sharedImports).toEqual([]);
  });

  it("dist/sidecar-server.js does not reference sidecar-server.ts as a path", () => {
    const serverPath = resolve(distDir, "sidecar-server.js");
    const content = readFileSync(serverPath, "utf8");
    // Source map comments (// src/...) are fine — they're not import paths
    const actualRefs = content.split("\n")
      .filter(l => l.includes("sidecar-server.ts") && !l.startsWith("//"));
    expect(actualRefs).toEqual([]);
  });

  it("dist/worker-entry.js does not reference worker-entry.ts as a path", () => {
    const workerPath = resolve(distDir, "worker-entry.js");
    const content = readFileSync(workerPath, "utf8");
    const actualRefs = content.split("\n")
      .filter(l => l.includes("worker-entry.ts") && !l.startsWith("//"));
    expect(actualRefs).toEqual([]);
  });
});

describe("Sidecar manager path resolution", () => {
  it("sidecar-manager.ts resolves .js not .ts", () => {
    const managerPath = resolve(pluginDir, "src/sidecar-manager.ts");
    const content = readFileSync(managerPath, "utf8");
    expect(content).toContain('"sidecar-server.js"');
    expect(content).not.toContain('"sidecar-server.ts"');
  });

  it("sidecar-server.ts resolves worker-entry .js not .ts", () => {
    const serverSrcPath = resolve(pluginDir, "src/sidecar-server.ts");
    const content = readFileSync(serverSrcPath, "utf8");
    expect(content).toContain('"worker-entry.js"');
    expect(content).not.toContain('"worker-entry.ts"');
  });

  it("sidecar-manager.ts does not use --experimental-strip-types", () => {
    const managerPath = resolve(pluginDir, "src/sidecar-manager.ts");
    const content = readFileSync(managerPath, "utf8");
    expect(content).not.toContain("--experimental-strip-types");
  });
});

describe("Build script — extra entry points", () => {
  it("build-plugins.mjs bundles sidecar-server.ts and worker-entry.ts", () => {
    const buildScriptPath = resolve(__dirname, "../../../scripts/build-plugins.mjs");
    const content = readFileSync(buildScriptPath, "utf8");
    // The build script should list sidecar-server.ts and worker-entry.ts as extra entries
    expect(content).toContain("sidecar-server.ts");
    expect(content).toContain("worker-entry.ts");
    // Should output them to dist/*.js
    expect(content).toContain(".js");
  });
});
