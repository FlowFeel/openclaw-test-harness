/**
 * Session guard manifest + structure tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

describe("oc-session-guard plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-session-guard");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("package.json exists", () => {
    expect(existsSync(resolve(pluginDir, "package.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  it("sessions-io exists", () => {
    expect(existsSync(resolve(pluginDir, "src/sessions-io.ts"))).toBe(true);
  });

  it("idle-guard-logic exists", () => {
    expect(existsSync(resolve(pluginDir, "src/idle-guard-logic.ts"))).toBe(true);
  });

  it("utils exists", () => {
    expect(existsSync(resolve(pluginDir, "src/utils.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it("declares session_health and session_cleanup tools", () => {
    expect(manifest.contracts.tools).toContain("session_health");
    expect(manifest.contracts.tools).toContain("session_cleanup");
  });

  it("declares after_compaction, session_end, and before_agent_run hooks", () => {
    expect(manifest.contracts.hooks).toContain("after_compaction");
    expect(manifest.contracts.hooks).toContain("session_end");
    expect(manifest.contracts.hooks).toContain("before_agent_run");
  });

  it("has bloat fields default and suppressIdleHeartbeats option", () => {
    const props = manifest.configSchema.properties;
    expect(props.bloatFields.default).toContain("compactionCheckpoints");
    expect(props.maxAgeHours.default).toBe(15);
    expect(props.suppressIdleHeartbeats.default).toBe(true);
  });
});
