/**
 * Level 2 E2E — patched OC gateway with hook debug instrumentation.
 *
 * Tests ALL trace event types from patch 0001 in a real running gateway:
 *   1. dispatch   — gateway_start fires (handlerCount:1)
 *   2. error      — gateway_start handler throws (swallowed:true)
 *   3. dispatch   — gateway_stop fires on shutdown (handlerCount:1)
 *   4. no-handlers — direct import, empty registry (reason:not-registered)
 *   5. zero-overhead — no trace file when OPENCLAW_HOOK_DEBUG not set
 *
 * The flow:
 *   1. Create a container with node:24-bookworm
 *   2. npm install openclaw@2026.6.8
 *   3. Apply the built-code hook instrumentation patch (patch-built-hooks.mjs)
 *   4. Install the test plugin (registers gateway_start + gateway_stop via api.on)
 *   5. Start the gateway with OPENCLAW_HOOK_DEBUG=1 + OPENCLAW_HOOK_TRACE_FILE
 *   6. Wait for gateway_start to fire (and throw, and be swallowed)
 *   7. Kill the gateway → gateway_stop fires
 *   8. Read the trace file → assert dispatch + error + dispatch
 *   9. Run zero-overhead test (no env → no trace)
 *  10. Run no-handlers test (direct import → no-handlers trace)
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let container: any;
let lifecycleTrace: string;

// ── Container setup (shared across all test groups) ─────────────────────

async function setupContainer() {
  const builder = await GenericContainer.fromDockerfile(
      path.resolve(REPO_ROOT),
      "docker/Dockerfile"
    ).withBuildkit().withCache(true).build()
    .withWorkingDir("/app")
    .withCommand(["tail", "-f", "/dev/null"]);

  const c = await builder.start();

  // 1. Install openclaw from npm.
  console.log("[e2e] installing openclaw...");
  await c.exec(["npm", "install", "--prefix", "/app", `openclaw@${OC_VERSION}`]);

  // 2. Apply the built-code hook instrumentation patch.
  console.log("[e2e] patching built hook runner...");
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

  const manifest = {
    id: "oc-e2e-trace-test",
    name: "OC E2E Trace Test",
    description: "Throws in gateway_start, succeeds in gateway_stop",
    contracts: { tools: [] },
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  };
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/openclaw.plugin.json << 'EOF'\n${JSON.stringify(manifest, null, 2)}\nEOF`]);

  // Plugin uses api.on() (typed hook registration) for both gateway_start and gateway_stop.
  // gateway_start throws → proves swallowed-error capture.
  // gateway_stop succeeds → proves dispatch capture on shutdown.
  const pluginJs = `export default {
  id: "oc-e2e-trace-test",
  name: "OC E2E Trace Test",
  description: "Throws in gateway_start, succeeds in gateway_stop",
  register(api) {
    api.on("gateway_start", async () => {
      api.logger?.info?.("[oc-e2e-trace-test] gateway_start fired — about to throw");
      throw new Error("e2e-trace-test: deliberate swallowed error");
    });
    api.on("gateway_stop", async () => {
      api.logger?.info?.("[oc-e2e-trace-test] gateway_stop fired — succeeding");
    });
  },
};`;
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/index.js << 'EOF'\n${pluginJs}\nEOF`]);

  const pluginPkg = { name: "oc-e2e-trace-test", version: "0.1.0", type: "module", main: "index.js" };
  await c.exec(["sh", "-c", `cat > /app/workspace/plugins/oc-e2e-trace-test/package.json << 'EOF'\n${JSON.stringify(pluginPkg, null, 2)}\nEOF`]);

  // 4. Write gateway config.
  const config = {
    gateway: { mode: "local", port: 8787 },
    plugins: {
      enabled: true,
      allow: ["oc-e2e-trace-test"],
      load: { paths: ["/app/workspace/plugins"] },
    },
  };
  await c.exec(["sh", "-c", `cat > /app/workspace/openclaw.json << 'EOF'\n${JSON.stringify(config, null, 2)}\nEOF`]);

  return c;
}

// ── Gateway lifecycle: start → wait for gateway_start → kill → wait for gateway_stop ─

async function runGatewayLifecycle(c: typeof container): Promise<string> {
  console.log("[e2e] starting gateway lifecycle...");
  const result = await c.exec([
    "sh", "-c",
    `export OPENCLAW_HOOK_DEBUG=1 OPENCLAW_HOOK_TRACE_FILE=/tmp/hook-trace.jsonl OPENCLAW_CONFIG_PATH=/app/workspace/openclaw.json && ` +
    `rm -f /tmp/hook-trace.jsonl && ` +
    `echo "=== STARTING GATEWAY ===" && ` +
    `timeout 60 node /app/node_modules/openclaw/openclaw.mjs gateway run --allow-unconfigured --bind loopback --auth none ` +
    `> /tmp/oc.log 2>&1 & ` +
    `GATEWAY_PID=$! && ` +
    `echo "gateway pid: $GATEWAY_PID" && ` +
    `for i in $(seq 1 15); do ` +
    `  sleep 2; ` +
    `  if [ -f /tmp/hook-trace.jsonl ]; then echo "gateway_start trace appeared after \${i} polls"; break; fi; ` +
    `  echo "poll \${i}: waiting for gateway_start..."; ` +
    `done && ` +
    `echo "=== KILLING GATEWAY ===" && ` +
    `kill $GATEWAY_PID 2>/dev/null; ` +
    `for i in $(seq 1 10); do ` +
    `  sleep 1; ` +
    `  if grep -q gateway_stop /tmp/hook-trace.jsonl 2>/dev/null; then echo "gateway_stop trace appeared after \${i} polls"; break; fi; ` +
    `  echo "poll \${i}: waiting for gateway_stop..."; ` +
    `done && ` +
    `echo "=== TRACE FILE ===" && (cat /tmp/hook-trace.jsonl 2>/dev/null || echo "NO_TRACE_FILE") && ` +
    `echo "=== OC LOG (last 10 lines) ===" && tail -10 /tmp/oc.log 2>/dev/null && ` +
    `echo "=== END ==="`,
  ]);
  return result.stdout;
}

// ── Zero-overhead: no trace when OPENCLAW_HOOK_DEBUG is not set ──────────

async function runZeroOverheadTest(c: typeof container): Promise<string> {
  console.log("[e2e] running zero-overhead test...");
  const result = await c.exec([
    "sh", "-c",
    `unset OPENCLAW_HOOK_DEBUG && ` +
    `export OPENCLAW_HOOK_TRACE_FILE=/tmp/hook-trace-overhead.jsonl OPENCLAW_CONFIG_PATH=/app/workspace/openclaw.json && ` +
    `rm -f /tmp/hook-trace-overhead.jsonl && ` +
    `echo "=== ZERO-OVERHEAD: starting WITHOUT OPENCLAW_HOOK_DEBUG ===" && ` +
    `timeout 30 node /app/node_modules/openclaw/openclaw.mjs gateway run --allow-unconfigured --bind loopback --auth none ` +
    `> /tmp/oc-overhead.log 2>&1 & ` +
    `OVERHEAD_PID=$! && ` +
    `for i in $(seq 1 10); do ` +
    `  sleep 2; ` +
    `  if grep -q "\\[gateway\\] ready" /tmp/oc-overhead.log 2>/dev/null; then echo "gateway ready after \${i} polls"; break; fi; ` +
    `done && ` +
    `sleep 3 && ` +
    `kill $OVERHEAD_PID 2>/dev/null; sleep 2 && ` +
    `echo "=== TRACE FILE CHECK ===" && ` +
    `if [ -f /tmp/hook-trace-overhead.jsonl ]; then echo "TRACE_FILE_EXISTS"; cat /tmp/hook-trace-overhead.jsonl; else echo "NO_TRACE_FILE"; fi && ` +
    `echo "=== GATEWAY STARTED CHECK ===" && ` +
    `grep -c "\\[gateway\\] ready" /tmp/oc-overhead.log 2>/dev/null && ` +
    `echo "=== END ==="`,
  ]);
  return result.stdout;
}

// ── No-handlers: direct import, empty registry ──────────────────────────

async function runNoHandlersTest(c: typeof container): Promise<string> {
  console.log("[e2e] running no-handlers test...");
  const script = `import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const distDir = "/app/node_modules/openclaw/dist";
const files = readdirSync(distDir).filter(
  (f) => f.startsWith("hook-runner-global-") && f.endsWith(".js"),
).filter((f) => readFileSync(join(distDir, f), "utf8").includes("function createHookRunner"));

if (files.length === 0) {
  console.log("ERROR: createHookRunner chunk not found");
  process.exit(1);
}

await import(join(distDir, files[0]));
const createHookRunner = globalThis.__createHookRunner;
if (!createHookRunner) {
  console.log("ERROR: globalThis.__createHookRunner not found (patch may not have exposed it)");
  process.exit(1);
}

const runner = createHookRunner(
  { typedHooks: [], hooks: [], plugins: [] },
  { enableTrace: true, catchErrors: true },
);

await runner.runSessionStart(
  { sessionId: "test", sessionKey: "agent:main:test", resumedFrom: null },
  { sessionId: "test", sessionKey: "agent:main:test", agentId: "main" },
);

const trace = runner.getTrace();
console.log(JSON.stringify(trace));
`;

  await c.exec(["sh", "-c", `cat > /tmp/no-handlers-test.mjs << 'PATCHEOF'\n${script}\nPATCHEOF`]);
  const result = await c.exec(["node", "/tmp/no-handlers-test.mjs"]);
  return result.stdout;
}

// ── Helper: extract trace JSONL lines from combined output ──────────────

function extractTraceLines(output: string): string[] {
  const traceStart = output.indexOf("=== TRACE FILE ===");
  const traceEnd = output.indexOf("=== OC LOG", traceStart);
  const traceEnd2 = output.indexOf("=== GATEWAY", traceStart);
  const ends = [traceEnd, traceEnd2].filter((i) => i > 0);
  const traceEndFinal = ends.length > 0 ? Math.min(...ends) : undefined;
  const traceSection = output.slice(traceStart, traceEndFinal);
  return traceSection.split("\n").filter((l) => l.startsWith("{"));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Level 2 E2E: patched gateway hook trace", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    container = await setupContainer();
    lifecycleTrace = await runGatewayLifecycle(container);
    console.log("[e2e] lifecycle trace:\n" + lifecycleTrace);
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  // ── Lifecycle: gateway_start dispatch + swallowed error ──────────────

  it("the gateway starts and produces a trace file", () => {
    expect(lifecycleTrace).not.toContain("NO_TRACE_FILE");
  });

  it("the trace captures the gateway_start hook dispatch", () => {
    expect(lifecycleTrace).toContain('"type":"dispatch"');
    expect(lifecycleTrace).toContain('"hookName":"gateway_start"');
  });

  it("the trace captures the swallowed error from the test plugin", () => {
    expect(lifecycleTrace).toContain("e2e-trace-test");
    expect(lifecycleTrace).toContain("deliberate swallowed error");
    expect(lifecycleTrace).toContain('"type":"error"');
    expect(lifecycleTrace).toContain('"swallowed":true');
  });

  // ── Lifecycle: gateway_stop dispatch on shutdown ─────────────────────

  it("the trace captures the gateway_stop hook dispatch on shutdown", () => {
    expect(lifecycleTrace).toContain('"hookName":"gateway_stop"');
  });

  it("the trace is structured JSONL (each line is valid JSON)", () => {
    const lines = extractTraceLines(lifecycleTrace);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeDefined();
      expect(parsed.type).toBeDefined();
      expect(parsed.hookName).toBeDefined();
    }
  });

  // ── Zero-overhead: no trace when OPENCLAW_HOOK_DEBUG is not set ──────

  describe("zero-overhead (trace disabled by default)", { timeout: 60_000 }, () => {
    let overheadResult: string;

    beforeAll(async () => {
      overheadResult = await runZeroOverheadTest(container);
      console.log("[e2e] overhead result:\n" + overheadResult);
    }, 60_000);

    it("the gateway starts successfully", () => {
      // Must prove the gateway actually started (otherwise the test is vacuous).
      expect(overheadResult).toContain("gateway ready");
    });

    it("does not create a trace file when OPENCLAW_HOOK_DEBUG is not set", () => {
      expect(overheadResult).toContain("NO_TRACE_FILE");
      expect(overheadResult).not.toContain("TRACE_FILE_EXISTS");
    });
  });

  // ── No-handlers: hook fires with 0 registered handlers ───────────────

  describe("no-handlers trace (direct import from built dist)", () => {
    let noHandlersResult: string;

    beforeAll(async () => {
      noHandlersResult = await runNoHandlersTest(container);
      console.log("[e2e] no-handlers result:\n" + noHandlersResult);
    });

    it("the direct import succeeds (createHookRunner is accessible)", () => {
      expect(noHandlersResult).not.toContain("ERROR:");
    });

    it("captures a no-handlers event with reason not-registered", () => {
      const trace = JSON.parse(noHandlersResult);
      const noHandlers = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "no-handlers",
      );
      expect(noHandlers).toBeDefined();
      expect(noHandlers.hookName).toBe("session_start");
      expect(noHandlers.reason).toBe("not-registered");
    });
  });
});
