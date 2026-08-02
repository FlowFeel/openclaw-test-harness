import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(
  process.cwd(),
  "src/plugins/oc-sidecar/openclaw.plugin.json"
);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

describe("oc-sidecar plugin manifest", () => {
  it("has correct id", () => {
    expect(manifest.id).toBe("oc-sidecar");
  });

  it("has name and description", () => {
    expect(manifest.name).toBe("OC Sidecar");
    expect(manifest.description).toContain("sidecar");
  });

  it("declares tools in contracts", () => {
    expect(manifest.contracts.tools).toContain("sidecar_health");
    expect(manifest.contracts.tools).toContain("sidecar_exec");
        expect(manifest.contracts.tools).toContain("session_health");
  });

  it("activates on startup", () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  it("has valid config schema", () => {
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties).toBeDefined();
    expect(manifest.configSchema.properties.sidecar).toBeDefined();
    expect(manifest.configSchema.properties.sessionCleanup).toBeDefined();
    expect(manifest.configSchema.properties.telemetry).toBeDefined();
  });

  it("sidecar config has sensible defaults", () => {
    const sidecar = manifest.configSchema.properties.sidecar.properties;
    expect(sidecar.port.default).toBe(18900);
    expect(sidecar.workerThreads.default).toBe(3);
    expect(sidecar.startupTimeoutMs.default).toBe(10000);
  });

  it("session cleanup config has bloat fields list", () => {
    const cleanup = manifest.configSchema.properties.sessionCleanup.properties;
    expect(cleanup.maxAgeHours.default).toBe(15);
    expect(cleanup.stripBloatFields.default).toBe(true);
    expect(cleanup.bloatFields.default).toContain("compactionCheckpoints");
  });

  it("telemetry config has enabled flag and interval", () => {
    const telemetry = manifest.configSchema.properties.telemetry.properties;
    expect(telemetry.enabled.default).toBe(true);
    expect(telemetry.collectIntervalMs.default).toBe(30000);
  });
});
