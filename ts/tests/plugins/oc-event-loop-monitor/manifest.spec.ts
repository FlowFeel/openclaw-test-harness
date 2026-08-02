/**
 * Event loop monitor manifest + structure tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("oc-event-loop-monitor plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-event-loop-monitor");

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

  it("declares event_loop_health tool", () => {
    expect(manifest.contracts.tools).toContain("event_loop_health");
  });

  it("has telemetry thresholds", () => {
    const props = manifest.configSchema.properties;
    expect(props.p99HealthyMs.default).toBe(50);
    expect(props.p99DegradedMs.default).toBe(200);
    expect(props.utilDegraded.default).toBe(0.7);
    expect(props.heapCriticalMb.default).toBe(500);
  });
});
