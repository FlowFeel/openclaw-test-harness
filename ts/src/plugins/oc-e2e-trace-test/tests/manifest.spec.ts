/**
 * oc-e2e-trace-test manifest + structure conformance test.
 *
 * @dft
 * - Structural: asserts the manifest declares what index.ts registers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

describe("oc-e2e-trace-test plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-e2e-trace-test");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it('has no tools declared', () => { expect(manifest.contracts.tools ?? []).toEqual([]); })
});
