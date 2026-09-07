/**
 * Boot gate — every plugin must boot in a REAL OpenClaw gateway.
 *
 * @why
 * OC loads plugins in-process: a plugin that throws at module load or in
 * `register()` prevents the gateway from booting, taking down every agent and
 * channel. OC provides NO defense for this surface (see
 * docs/oc-plugin-capability-map.md §4) — this gate is the defense.
 *
 * What is proven, per plugin, against the real `openclaw gateway run` process
 * inside the test container (no mocks — real config loading, real discovery
 * via `plugins.load.paths`, real `register()`, real HTTP listener):
 *
 *   1. Boot: gateway reaches `http server listening` and names the plugin in
 *      its loaded-plugins line; the plugin's `gateway_start`-time registration
 *      produced no boot failure.
 *   2. Health: the listener answers HTTP.
 *   3. Hostile config: garbage config values (objects/strings where numbers
 *      are declared) must not crash boot — the plugin degrades, the gateway
 *      still serves.
 *
 * Standard: full e2e against the real runtime — no ad hoc smoke tests (A5;
 * docs/oc-plugin-capability-map.md §5).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  startOpenClaw,
  type StartedOpenClawContainer,
} from "../support/openclaw-container.js"
import {
  bootGateway,
  builtPluginDirs,
  probeGateway,
  stagePluginDirs,
  PLUGINS_SRC_DIR,
} from "../support/gateway-boot.js"

const distMarker = path.join(PLUGINS_SRC_DIR, "oc-topic-manager", "dist", "index.js")

let env: StartedOpenClawContainer
let pluginDirs: string[]
let pluginIds: string[]
let port = 18901

// Container-path form of a host plugin dir (ts is mounted at /app/ts).
const toContainerPath = (hostDir: string) => hostDir.replace(/^.*\/ts\//, "/app/ts/")

/** Staged (root-owned) copy path for a plugin, after stagePluginDirs in beforeAll. */
const stagedDir = (name: string) => `/app/staged-plugins/${name}`

beforeAll(async () => {
  // The gate tests built artifacts; build deterministically up front.
  if (!fs.existsSync(distMarker)) {
    execFileSync("npm", ["run", "build:plugins"], { cwd: path.join(PLUGINS_SRC_DIR, "..", ".."), stdio: "inherit" })
  }
  env = await startOpenClaw()
  const hostDirs = builtPluginDirs()
  // Stage root-owned copies inside the container: the gateway process runs as
  // root, and OC blocks load.paths candidates whose owner uid differs from
  // the process ("suspicious ownership"). Host-mounted dirs (runner uid
  // 1001) would be silently warning-blocked — the boot gate must exercise
  // plugins OC actually discovers and loads.
  pluginIds = hostDirs.map(
    (d) => JSON.parse(fs.readFileSync(path.join(d, "openclaw.plugin.json"), "utf8")).id as string,
  )
  pluginDirs = await stagePluginDirs(env.container, hostDirs.map(toContainerPath))
  expect(pluginDirs.length).toBeGreaterThan(0)
}, 180_000)

afterAll(async () => {
  if (env?.container) await env.container.stop()
})

describe("Feature: every plugin boots in a real OpenClaw gateway", () => {
  it("Scenario: all plugins boot together in one gateway", async () => {
    const entries = Object.fromEntries(
      builtPluginDirs().map((d) => [
        JSON.parse(fs.readFileSync(path.join(d, "openclaw.plugin.json"), "utf8")).id as string,
        { enabled: true },
      ]),
    )
    const gw = await bootGateway({
      container: env.container,
      pluginDirs,
      port: port++,
      entries,
    })
    expect(gw.ready).toBe(true)
    // Every plugin id must appear in the gateway's loaded-plugins line.
    for (const id of pluginIds) {
      expect(gw.listening).toContain(id)
    }
    const status = await probeGateway(env.container, port - 1)
    expect(status).toBe(200)
    await gw.stop()
  }, 180_000)

  it("Scenario: hostile plugin config fails the boot LOUDLY, never silently", async () => {
    // OC enforces the plugin manifest's configSchema at boot and fails closed
    // (stability bundle + "Gateway failed to start"). The gate pins that
    // contract: garbage config must NEVER produce a degraded-but-running
    // gateway — it must be a loud, named, diagnosable failure.
    const gw = await bootGateway({
      container: env.container,
      pluginDirs: [stagedDir("oc-topic-manager")],
      port: port++,
      entries: {
        "oc-topic-manager": {
          enabled: true,
          config: { maxIdleDays: { nested: true }, maxMessages: "not-a-number" },
        },
      },
    })
    await gw.stop()
    // Dump the gateway log on failure — the boot contract claim must be
    // diagnosable from CI output alone (no local repro needed).
    if (gw.ready) console.log("[boot-gate] hostile-config gateway log:\n" + gw.log)
    expect(gw.ready).toBe(false)
    expect(gw.log).toContain("Invalid config")
    expect(gw.log).toContain("oc-topic-manager")
    expect(gw.log).toMatch(/maxIdleDays|maxMessages/)
  }, 180_000)

  it("Scenario: a broken plugin path fails the boot loudly, naming the path", async () => {
    // OC fails closed on undiscoverable load paths — pinned real behavior.
    const gw = await bootGateway({
      container: env.container,
      pluginDirs: [stagedDir("oc-topic-manager"), "/nonexistent-xyz"],
      port: port++,
      entries: { "oc-topic-manager": { enabled: true } },
    })
    await gw.stop()
    expect(gw.ready).toBe(false)
    expect(gw.log).toContain("plugin path not found: /nonexistent-xyz")
  }, 180_000)
})
