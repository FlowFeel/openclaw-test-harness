/**
 * oc-lane-forecaster manifest + structure conformance test.
 *
 * @dft
 * - Structural: asserts the manifest declares what index.ts registers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("oc-lane-forecaster plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-lane-forecaster");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it("declares expected tools", () => {
    expect(manifest.contracts.tools).toEqual(["lane_forecast"]);
  });

  it("declares expected hooks", () => {
    expect(manifest.contracts.hooks).toEqual([
      "before_dispatch",
      "before_agent_run",
      "agent_end",
    ]);
  });
});
