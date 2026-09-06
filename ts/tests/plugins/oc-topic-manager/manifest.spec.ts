/**
 * oc-topic-manager manifest + structure tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("oc-topic-manager plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-topic-manager");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("package.json exists", () => {
    expect(existsSync(resolve(pluginDir, "package.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it("declares topic_audit and topic_recover tools", () => {
    expect(manifest.contracts.tools).toContain("topic_audit");
    expect(manifest.contracts.tools).toContain("topic_recover");
  });

  it("declares archival thresholds in config schema", () => {
    const props = manifest.configSchema.properties;
    expect(props.maxIdleDays.default).toBe(14);
    expect(props.maxMessages.default).toBe(2000);
  });

  it("pure modules stay small (DFT file-size rule)", () => {
    for (const f of ["parse-topics.ts", "detect-orphans.ts", "archival-policy.ts", "recovery-plan.ts"]) {
      const src = readFileSync(resolve(pluginDir, "src", f), "utf8");
      expect(src.split("\n").length).toBeLessThan(80);
    }
  });
});