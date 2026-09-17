/**
 * oc-task-plane manifest + structure conformance test.
 *
 * @dft
 * - Structural: asserts the manifest declares what index.ts registers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

describe("oc-task-plane plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-task-plane");

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
    expect(manifest.contracts.tools).toEqual(["task_dispatch","task_status","task_output","task_cancel"]);
  });
});
