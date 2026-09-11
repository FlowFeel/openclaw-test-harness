/**
 * Tool boundary specs — hostile inputs fired at the REAL gateway RPC surface
 * (`tools.invoke` over the gateway websocket protocol, token auth, operator
 * scope). The system under test is OC's boundary: whatever the payload, the
 * gateway must respond with a protocol-shaped result (payload ok=false +
 * error, never a hang) and keep serving. Proven against a real
 * `openclaw gateway run` process in the test container.
 *
 * Feature: tests/features/plugin-crash-insurance.feature
 *   Rule: Tool boundary — every input gets a protocol-shaped response
 *
 * @dft
 * - Real gateway process, real plugin registration, real RPC dispatch (A5).
 * - The WS client speaks the actual gateway protocol (connect handshake with
 *   token + operator.admin scope, then `{type:"req", method:"tools.invoke"}`),
 *   mirroring OC's own test-helpers.server.ts rpcReq shape.
 * - Ephemeral ports (no hardcoded races); fresh registry fixture per test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import type { StartedTestContainer } from "testcontainers"
import { startOpenClaw, type StartedOpenClawContainer } from "../support/openclaw-container.js"
import {
  bootGateway,
  builtPluginDirs,
  probeGateway,
  stagePluginDirs,
} from "../support/gateway-boot.js"

const distMarker = path.join(
  path.dirname(path.dirname(__dirname)),
  "src/plugins/oc-topic-manager/dist/index.js",
)

let env: StartedOpenClawContainer
let gw: Awaited<ReturnType<typeof bootGateway>>
let port = 19001

const toContainerPath = (hostDir: string) => hostDir.replace(/^.*\/ts\//, "/app/ts/")

interface InvokeResult {
  ok: boolean
  payload?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

/**
 * Speak the gateway protocol from INSIDE the container (ws ships with the
 * globally installed OC). Sends `connect` (token auth, operator.admin scope —
 * the boundary's owner path), then a sequence of tools.invoke requests.
 * Returns the parsed responses. Exits non-zero on transport failure — the
 * spec treats that as the boundary failing the "never hang" requirement.
 */
async function invokeTools(
  container: StartedTestContainer,
  gwPort: number,
  cases: Array<{ label: string; params: unknown }>,
  registryFixture?: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  if (registryFixture) {
    const dir = "/root/.openclaw/agents/main/sessions"
    const write = await container.exec([
      "sh",
      "-c",
      `mkdir -p ${dir} && cat > ${dir}/sessions.json <<'EOC'\n${JSON.stringify(registryFixture)}\nEOC`,
    ])
    expect(write.exitCode).toBe(0)
  }

  const script = `
    const OCRM = require("child_process").execSync("npm root -g").toString().trim();
    const WebSocket = require(OCRM + "/openclaw/node_modules/ws");
    const PORT = ${gwPort};
    const TOKEN = "gate-e2e-token";
    // Huge payloads are generated in-container — they cannot travel through
    // the exec argument list.
    const GENERATORS = { "generate-huge": () => ({ name: "topic_audit", args: { topics: { topics: [{ id: 1, name: "x".repeat(1024 * 1024) }] } } }) };
    const CASES = ${JSON.stringify(cases)}.map(c => c.params === "GENERATE_HUGE" ? { label: c.label, params: GENERATORS[c.label]() } : c);
    const PROTOCOL = 4;
    function rpc(ws, method, params) {
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for res: " + method)), 15000);
        const onMsg = (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === "res" && m.id === id) {
            ws.off("message", onMsg);
            clearTimeout(timer);
            resolve(m);
          }
        };
        ws.on("message", onMsg);
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    }
    (async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + PORT);
      await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
        setTimeout(() => rej(new Error("ws open timeout")), 10000);
      });
      const hello = await rpc(ws, "connect", {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "cli", version: "1.0.0", platform: "test", mode: "cli" },
        caps: [], role: "operator", scopes: ["operator.admin"],
        auth: { token: TOKEN },
      });
      if (!hello.ok) { console.error("connect failed: " + JSON.stringify(hello)); process.exit(3); }
      const results = [];
      for (const c of CASES) {
        try {
          const res = await rpc(ws, "tools.invoke", c.params);
      results.push({ label: c.label, type: res.type, ok: res.ok, payload: res.payload ?? null, error: res.error ?? null, raw: JSON.stringify(res).slice(0, 300) });
        } catch (e) {
          results.push({ label: c.label, transportError: String(e && e.message || e) });
        }
      }
      ws.close();
      console.log(JSON.stringify(results));
      process.exit(0);
    })().catch(e => { console.error("FATAL: " + (e && e.message || e)); process.exit(4); });
  `
  const result = await container.exec([
    "sh",
    "-c",
    `node -e '${script.replace(/'/g, "'\\''")}'`,
  ])
  if (result.exitCode !== 0) {
    throw new Error(
      `ws client failed (exit ${result.exitCode}): ${result.output} ${result.stderr}`,
    )
  }
  const line = result.output.trim().split("\n").pop() ?? "[]"
  // eslint-disable-next-line no-console -- boundary contract is under investigation; keep responses visible in CI logs
  console.log("[tool-boundary responses]", line)
  return JSON.parse(line) as Array<Record<string, unknown>>
}

beforeAll(async () => {
  if (!fs.existsSync(distMarker)) {
    execFileSync("npm", ["run", "build:plugins"], {
      cwd: path.join(path.dirname(distMarker), "..", "..", ".."),
      stdio: "inherit",
    })
  }
  env = await startOpenClaw()
  const hostDirs = builtPluginDirs().filter((d) => d.endsWith("oc-topic-manager"))
  const staged = await stagePluginDirs(env.container, hostDirs.map((d) =>
    d.replace(/^.*\/ts\//, "/app/ts/"),
  ))
  gw = await bootGateway({
    container: env.container,
    pluginDirs: staged,
    port: port,
    entries: { "oc-topic-manager": { enabled: true } },
  })
  expect(gw.ready).toBe(true)
}, 240_000)

afterAll(async () => {
  await gw?.stop()
  if (env?.container) await env.container.stop()
})

const VALID_TOPICS = {
  topics: [
    { id: 82385, name: "war-stories", lastActiveAt: "2026-09-01T00:00:00Z" },
    { id: 73239, name: "old-thread", lastActiveAt: "2026-01-01T00:00:00Z" },
  ],
}

describe("Feature: the tool boundary answers every input and survives", () => {
  it("Scenario: missing tool name is rejected with an error shape", async () => {
    const [res] = await invokeTools(env.container, port, [
      { label: "no-name", params: {} },
    ])
    expect(res.type).toBe("res")
    // Pinned contract: invalid REQUEST shape → transport-level error.
    expect(res.ok).toBe(false)
    expect((res.error as { code?: string }).code).toBe("INVALID_REQUEST")
    expect(String((res.error as { message?: string }).message)).toMatch(/name/)
    expect(await probeGateway(env.container, port)).toBe(200)
  }, 120_000)

  it("Scenario: unknown tool name is rejected without crashing", async () => {
    const [res] = await invokeTools(env.container, port, [
      { label: "unknown-tool", params: { name: "definitely_not_a_tool" } },
    ])
    const payload = res.payload as { ok?: boolean; error?: { code?: string; message?: string } }
    expect(res.ok).toBe(true)
    expect(payload.ok).toBe(false)
    expect(payload.error?.code).toBe("not_found")
    expect(await probeGateway(env.container, port)).toBe(200)
  }, 120_000)

  it("Scenario: null and wrong-typed params are rejected, not fatal", async () => {
    const results = await invokeTools(env.container, port, [
      { label: "null-params", params: null },
      { label: "wrong-types", params: { name: "topic_audit", params: "not-an-object" } },
      { label: "valid-after-hostile", params: { name: "topic_audit", args: { topics: { topics: [] } } } },
    ])
    for (const res of results.slice(0, 2)) {
      expect(res.type).toBe("res")
      // Pinned contract: malformed params → transport INVALID_REQUEST with a
      // named validation message. Never a hang, never a crash.
      expect(res.ok).toBe(false)
      expect((res.error as { code?: string }).code).toBe("INVALID_REQUEST")
      expect(String((res.error as { message?: string }).message)).toMatch(/invalid tools\.invoke params/)
    }
    // A follow-up VALID call must still succeed through the same connection
    // — the boundary is reusable after hostile input.
    const valid = results[2]
    expect(valid.ok).toBe(true)
    const payload = valid.payload as { ok?: boolean }
    expect(payload?.ok).toBe(true)
    expect(await probeGateway(env.container, port)).toBe(200)
  }, 120_000)

  it("Scenario: oversized string payload does not kill the gateway", async () => {
    const [res] = await invokeTools(env.container, port, [
      { label: "generate-huge", params: "GENERATE_HUGE" },
    ])
    expect(res.type).toBe("res")
    if (res.ok) {
      // Either a success or a protocol-shaped failure — both are boundary responses.
      expect(res.payload).not.toBeNull()
    } else {
      expect(String((res.error as { message?: string } | undefined)?.message ?? "")).toBeTruthy()
    }
    expect(await probeGateway(env.container, port)).toBe(200)
  }, 120_000)

  it("Scenario: valid tool call succeeds through the same boundary", async () => {
    const [res] = await invokeTools(
      env.container,
      port,
      [{ label: "valid", params: { name: "topic_audit", args: { topics: { topics: [] } } } }],
      { "agent:main:telegram:group:-1003842172831:topic:82385": {
          topicId: 82385,
          chatId: "-1003842172831",
          agentId: "main",
          registeredAtMs: 1_788_000_000_000,
          registeredAt: "2026-09-01T00:00:00.000Z",
          source: "oc-topic-manager",
      } },
    )
    expect(res.type).toBe("res")
    expect(res.ok).toBe(true)
    const payload = res.payload as {
      ok?: boolean
      toolName?: string
      output?: { content?: Array<{ type?: string; text?: string }> }
    }
    expect(payload.ok).toBe(true)
    expect(payload.toolName).toBe("topic_audit")
    // The audit report round-trips through the boundary as an MCP text
    // response; parse it and check the report fields, including the entry
    // read from the real on-disk registry fixture.
    const text = payload.output?.content?.find((c) => c.type === "text")?.text ?? ""
    const report = JSON.parse(text) as { orphaned?: unknown[]; unregistered?: Array<{ topicId?: number; sessionKey?: string }>; archivalDecisions?: unknown[] }
    expect(Array.isArray(report.orphaned)).toBe(true)
    expect(Array.isArray(report.archivalDecisions)).toBe(true)
    // The registration from the registry fixture is surfaced as unregistered
    // (no topics provided to match against) — proves the tool read the real
    // registry through the boundary.
    expect(report.unregistered?.some((u) => u.sessionKey === "agent:main:telegram:group:-1003842172831:topic:82385")).toBe(true)
    expect(await probeGateway(env.container, port)).toBe(200)
  }, 120_000)
})
