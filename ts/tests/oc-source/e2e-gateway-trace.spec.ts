/**
 * Level 2 E2E — patched OC gateway with hook debug instrumentation.
 *
 * This is the REAL gateway E2E: a running OpenClaw gateway (from the npm
 * tarball) with the built hook runner PATCHED in-container to add the trace
 * instrumentation. A foundry-generated plugin (oc-e2e-trace-test) registers
 * a gateway_start hook that THROWS — proving the swallowed-error visibility
 * that patch 0001 provides.
 *
 * The flow:
 *   1. Create a container with node:24-bookworm
 *   2. npm install openclaw@2026.6.8
 *   3. Apply the built-code hook instrumentation patch (patch-built-hooks.mjs)
 *   4. Install the oc-e2e-trace-test plugin
 *   5. Start the gateway with OPENCLAW_HOOK_DEBUG=1 + OPENCLAW_HOOK_TRACE_FILE
 *   6. Wait for the gateway_start hook to fire (and throw, and be swallowed)
 *   7. Read the trace file
 *   8. Assert the trace captures the swallowed error
 *
 * This proves the end-to-end claim: "hooks not working" (swallowed errors)
 * becomes "here's the trace showing exactly what happened."
 *
 * @dft
 * - Uses testcontainers (hermetic, ephemeral)
 * - The trace file is the assertion's evidence (CheckResult pattern)
 * - No network calls to real LLMs (gateway starts but doesn't process messages)
 */

import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { GenericContainer } from "testcontainers";
import * as path from "node:path";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const TS_DIR = path.join(REPO_ROOT, "ts");
const OC_VERSION = "2026.6.8";
const PATCH_SCRIPT = path.join(TS_DIR, "tests/support/patch-built-hooks.mjs");

// Container handle — started in beforeAll, stopped in afterAll.
let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

async function startPatchedGateway() {
  const builder = new GenericContainer("node:24-bookworm")
    .withWorkingDir("/app")
    .withCommand(["tail", "-f", "/dev/null"]);

  const c = await builder.start();

  // 1. Install openclaw from npm.
  console.log("[e2e] installing openclaw...");
  await c.exec(["npm", "install", "--prefix", "/app", `openclaw@${OC_VERSION}`]);

  // 2. Apply the built-code hook instrumentation patch.
  console.log("[e2e] patching built hook runner...");
  // Copy the patch script into the container.
  const patchScript = fs.readFileSync(PATCH_SCRIPT, "utf8");
  await c.exec(["sh", "-c", `cat > /tmp/patch-built-hooks.mjs << 'PATCHEOF'\n${patchScript}\nPATCHEOF`]);
  const patchResult = await c.exec([
    "node", "/tmp/patch-built-hooks.mjs", "/app/node_modules/openclaw/dist",
  ]);
  if (patchResult.exitCode !== 0) {
    throw new Error(`Patch script failed: ${patchResult.stderr}`);
  }
  console.log("[e2e]", patchResult.stdout.trim());

  // 3. Install the test plugin (plain JS — OC can't load TypeScript directly).
  console.log("[e2e] installing test plugin...");
  await c.exec(["mkdir", "-p", "/app/workspace/plugins/oc-e2e-trace-test"]);

  // Write a minimal JS plugin manifest + entry that throws in gateway_start.
  const manifest = {
    id: "oc-e2e-trace-test",
    name: "OC E2E Trace Test",
    description: "Throws in gateway_start to prove swallowed-error visibility",
    contracts: { tools: [] },
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  };
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/openclaw.plugin.json << 'EOF'\n${JSON.stringify(manifest, null, 2)}\nEOF`]);

  // Plain JS entry — ESM format (OC is ESM).
  // Uses api.on() (typed hook registration) NOT api.registerHook() (legacy).
  // Only typed hooks are visible to hasHooks()/getHooksForName() which gate dispatch.
  const pluginJs = `export default {
  id: "oc-e2e-trace-test",
  name: "OC E2E Trace Test",
  description: "Throws in gateway_start to prove swallowed-error visibility",
  register(api) {
    api.on("gateway_start", async () => {
      api.logger?.info?.("[oc-e2e-trace-test] gateway_start hook fired — about to throw");
      throw new Error("e2e-trace-test: deliberate swallowed error");
    });
    api.on("gateway_stop", async () => {
      api.logger?.info?.("[oc-e2e-trace-test] gateway_stop hook fired");
    });
  },
};`;
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/index.js << 'EOF'\n${pluginJs}\nEOF`]);

  // package.json — tells OC where the entry point is.
  const pluginPkg = { name: "oc-e2e-trace-test", version: "0.1.0", type: "module", main: "index.js" };
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/package.json << 'EOF'\n${JSON.stringify(pluginPkg, null, 2)}\nEOF`]);

  // 4. Start the gateway with hook debug enabled.
  console.log("[e2e] starting gateway with OPENCLAW_HOOK_DEBUG=1...");
  const config = {
    gateway: {
      mode: "local",
      port: 8787,
    },
    plugins: {
      enabled: true,
      allow: ["oc-e2e-trace-test"],
      load: {
        paths: ["/app/workspace/plugins"],
      },
    },
  };
  await c.exec(["sh", "-c", `cat > /app/workspace/openclaw.json << 'EOF'\n${JSON.stringify(config, null, 2)}\nEOF`]);

  // Start the gateway in the background with trace enabled, then poll for the trace file.
  const startResult = await c.exec([
    "sh", "-c",
    `export OPENCLAW_HOOK_DEBUG=1 OPENCLAW_HOOK_TRACE_FILE=/tmp/hook-trace.jsonl OPENCLAW_CONFIG_PATH=/app/workspace/openclaw.json && ` +
    `echo "=== PATCH VERIFICATION ===" && ` +
    `echo "enableTrace count:" && grep -c enableTrace /app/node_modules/openclaw/dist/hook-runner-global-*.js | tail -1 && ` +
    `echo "captureTrace count:" && grep -c captureTrace /app/node_modules/openclaw/dist/hook-runner-global-*.js | tail -1 && ` +
    `echo "dispatch trace count:" && grep -c 'type: "dispatch"' /app/node_modules/openclaw/dist/hook-runner-global-*.js | tail -1 && ` +
    `echo "=== STARTING GATEWAY ===" && ` +
    `timeout 30 node /app/node_modules/openclaw/openclaw.mjs gateway run --allow-unconfigured --bind loopback --auth none ` +
    `> /tmp/oc.log 2>&1 & ` +
    `GATEWAY_PID=$! && ` +
    `echo "gateway pid: $GATEWAY_PID" && ` +
    `for i in $(seq 1 15); do ` +
    `  sleep 2; ` +
    `  if [ -f /tmp/hook-trace.jsonl ]; then echo "trace file appeared after \${i} polls"; break; fi; ` +
    `  echo "poll \${i}: no trace file yet..."; ` +
    `done && ` +
    `echo "=== PROCESS CHECK ===" && (kill -0 $GATEWAY_PID 2>/dev/null && echo "gateway still running" || echo "gateway exited") && ` +
    `echo "=== TRACE FILE ===" && (cat /tmp/hook-trace.jsonl 2>/dev/null || echo "NO_TRACE_FILE") && ` +
    `echo "=== FULL OC LOG ===" && cat /tmp/oc.log 2>/dev/null && ` +
    `echo "=== END ==="`,
  ]);

  console.log("[e2e] start result:\n" + startResult.stdout);

  return { container: c, startResult };
}

describe("Level 2 E2E: patched gateway hook trace", { timeout: 120_000 }, () => {
  let traceContent: string;

  beforeAll(async () => {
    const result = await startPatchedGateway();
    container = result.container;
    traceContent = result.startResult.stdout;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("the gateway starts and produces a trace file", () => {
    // The trace file should exist (the gateway started, hooks fired).
    expect(traceContent).not.toContain("NO_TRACE_FILE");
  });

  it("the trace captures the gateway_start hook dispatch", () => {
    // The trace should contain a dispatch event for gateway_start.
    expect(traceContent).toContain("gateway_start");
  });

  it("the trace captures the swallowed error from the test plugin", () => {
    // The test plugin's gateway_start hook throws deliberately.
    // With catchErrors=true (default), the error is swallowed — but the
    // trace captures it with swallowed:true.
    expect(traceContent).toContain("e2e-trace-test");
    expect(traceContent).toContain("deliberate swallowed error");
    expect(traceContent).toContain('"type":"error"');
    expect(traceContent).toContain('"swallowed":true');
  });

  it("the trace is structured JSONL (each line is valid JSON)", () => {
    // Extract just the trace file content (between "=== TRACE FILE ===" and "=== FULL OC LOG ===")
    const traceStart = traceContent.indexOf("=== TRACE FILE ===");
    const traceEnd = traceContent.indexOf("=== FULL OC LOG ===", traceStart);
    const traceSection = traceContent.slice(traceStart, traceEnd > 0 ? traceEnd : undefined);
    // Skip the marker line itself, take only the JSON lines.
    const lines = traceSection.split("\n").filter((l) => l.startsWith("{"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeDefined();
      expect(parsed.type).toBeDefined();
      expect(parsed.hookName).toBeDefined();
    }
  });
});
