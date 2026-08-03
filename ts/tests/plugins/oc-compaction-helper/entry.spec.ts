import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "src/plugins/oc-compaction-helper");

describe("Feature: oc-compaction-helper Plugin Structure", () => {
  it("Scenario: Manifest exists and is valid", () => {
    expect(existsSync(resolve(dir, "openclaw.plugin.json"))).toBe(true);
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.id).toBe("oc-compaction-helper");
    expect(m.contracts.tools).toContain("compact_check");
    expect(m.activation.onStartup).toBe(true);
  });

  it("Scenario: Package.json exists", () => {
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
  });

  it("Scenario: Entry point exists", () => {
    expect(existsSync(resolve(dir, "src/index.ts"))).toBe(true);
  });

  it("Scenario: Config schema has maxTranscriptMb default", () => {
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.configSchema.properties.maxTranscriptMb.default).toBe(5);
  });
});
