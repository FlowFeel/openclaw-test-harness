import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "src/plugins/oc-sidecar");

describe("Feature: oc-sidecar Plugin Structure (worker-only)", () => {
  it("Scenario: Manifest exists and is valid", () => {
    expect(existsSync(resolve(dir, "openclaw.plugin.json"))).toBe(true);
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.id).toBe("oc-sidecar");
    expect(m.contracts.tools).toContain("sidecar_health");
    expect(m.contracts.tools).toContain("sidecar_exec");
    expect(m.contracts.tools).toHaveLength(2);
  });

  it("Scenario: Package.json exists", () => {
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
  });

  it("Scenario: Entry point exists", () => {
    expect(existsSync(resolve(dir, "src/index.ts"))).toBe(true);
  });

  it("Scenario: Only 2 tools declared (no conflicts with orchestrator)", () => {
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.contracts.tools).not.toContain("session_health");
    expect(m.contracts.tools).not.toContain("event_loop_health");
  });
});
