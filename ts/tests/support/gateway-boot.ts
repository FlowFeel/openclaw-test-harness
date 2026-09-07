/**
 * Gateway boot helper — start the REAL OpenClaw gateway inside the test
 * container with a given plugin load configuration.
 *
 * @dft
 * - No mocks: this is the real `openclaw gateway run` process, real config
 *   loading, real plugin discovery (`plugins.load.paths`), real plugin
 *   `register()` calls, real HTTP listener.
 * - Used by the boot gate (tests/e2e/plugin-boot-gate.spec.ts) and reusable
 *   by the tool-boundary gate.
 */

import type { StartedTestContainer } from "testcontainers"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PLUGINS_SRC_DIR = path.resolve(__dirname, "../../src/plugins")

export interface GatewayBootHandle {
  /** True when the gateway reached "http server listening". */
  ready: boolean
  /** Full gateway log (always captured, even on failed boot). */
  log: string
  /** Full log when ready (contains the loaded-plugins line); else empty. */
  listening: string
  stop: () => Promise<void>
}

/** All oc-* plugin directories that have a built dist/index.js. */
export function builtPluginDirs(): string[] {
  return fs
    .readdirSync(PLUGINS_SRC_DIR)
    .filter((d) => d.startsWith("oc-"))
    .filter((d) => fs.existsSync(path.join(PLUGINS_SRC_DIR, d, "dist", "index.js")))
    .map((d) => path.join(PLUGINS_SRC_DIR, d))
}

export interface BootGatewayOptions {
  container: StartedTestContainer
  /** Plugin directories (container paths) to load via plugins.load.paths. */
  pluginDirs: string[]
  /** Unique port inside the container. */
  port: number
  /** Plugin ids → entry config (enabled: true at minimum). */
  entries: Record<string, { enabled: boolean; config?: Record<string, unknown> }>
  /** Extra config merged at top level (e.g. hostile values). */
  configOverrides?: Record<string, unknown>
  /** Log file path inside the container. */
  logFile?: string
  timeoutMs?: number
}

/**
 * Stage root-owned copies of plugin dirs inside the container.
 *
 * @why
 * OC's discovery blocks `plugins.load.paths` candidates whose owner uid
 * differs from the gateway process ("suspicious ownership" — anti-tamper
 * for other-user plugin injection). The harness mounts ts/ from the host
 * (runner uid 1001) but runs the gateway as root (uid 0), so host-mounted
 * plugin dirs are never actually loaded — only warning-blocked. Copying the
 * dirs inside the container as root re-owners them, letting discovery and
 * register() run for real.
 *
 * @dft I/O in container only; no mocks, no host mutation.
 */
export async function stagePluginDirs(
  container: StartedTestContainer,
  containerDirs: string[],
): Promise<string[]> {
  const stagedRoot = "/app/staged-plugins"
  const rm = await container.exec(["sh", "-c", `rm -rf ${stagedRoot} && mkdir -p ${stagedRoot}`])
  if (rm.exitCode !== 0) throw new Error(`staging prep failed: ${rm.output}`)
  for (const dir of containerDirs) {
    const name = dir.split("/").pop() ?? dir
    const cp = await container.exec([
      "sh",
      "-c",
      `cp -r ${dir} ${stagedRoot}/${name} && chown -R root:root ${stagedRoot}/${name}`,
    ])
    if (rm.exitCode !== 0 || cp.exitCode !== 0) {
      throw new Error(`staging failed for ${dir}: ${cp.output}`)
    }
  }
  return containerDirs.map((d) => `${stagedRoot}/${d.split("/").pop()}`)
}

/**
 * Boot a real gateway in the container. Resolves when the listener is up;
 * the caller must stop() it.
 */
export async function bootGateway(opts: BootGatewayOptions): Promise<GatewayBootHandle> {
  const {
    container,
    pluginDirs,
    port,
    entries,
    configOverrides = {},
    logFile = `/tmp/gw-${port}.log`,
    timeoutMs = 90_000,
  } = opts

  const config = {
    gateway: { mode: "local" },
    plugins: {
      load: { paths: pluginDirs },
      entries,
    },
    ...configOverrides,
  }
  const configPath = `/tmp/gate-config-${port}.json`
  const write = await container.exec([
    "sh",
    "-c",
    `cat > ${configPath} <<'EOC'\n${JSON.stringify(config, null, 2)}\nEOC`,
  ])
  if (write.exitCode !== 0) throw new Error(`config write failed: ${write.output}`)

  // Fresh log file per boot.
  await container.exec(["sh", "-c", `rm -f ${logFile}`])

  const start = await container.exec([
    "sh",
    "-c",
    `nohup env OPENCLAW_GATEWAY_TOKEN=gate-e2e-token OPENCLAW_CONFIG_PATH=${configPath} ` +
      `openclaw gateway run --port ${port} --bind loopback > ${logFile} 2>&1 & echo $! > ${logFile}.pid`,
  ])
  if (start.exitCode !== 0) throw new Error(`gateway start failed: ${start.output}`)

  const deadline = Date.now() + timeoutMs
  let log = ""
  async function stop(): Promise<void> {
    await container.exec(["sh", "-c", `kill $(cat ${logFile}.pid) 2>/dev/null; true`])
  }
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const cat = await container.exec(["sh", "-c", `cat ${logFile} 2>/dev/null || true`])
    log = cat.output
    // OC fails closed on invalid config / undiscoverable load paths — an
    // explicit startup failure is a terminal outcome, not a timeout.
    if (log.includes("Gateway failed to start") || log.includes("Gateway start blocked")) {
      return { ready: false, log, listening: "", stop }
    }
    if (log.includes("http server listening")) {
      return { ready: true, log, listening: log, stop }
    }
  }
  return { ready: false, log, listening: "", stop }
}

/** HTTP probe executed inside the container (no curl needed). */
export async function probeGateway(
  container: StartedTestContainer,
  port: number
): Promise<number> {
  const result = await container.exec([
    "node",
    "-e",
    `fetch("http://127.0.0.1:${port}/").then(r => { console.log(r.status); process.exit(0) })
     .catch(e => { console.error(e.message); process.exit(1) })`,
  ])
  const status = Number(result.output.trim())
  if (!Number.isFinite(status)) {
    throw new Error(`gateway probe failed: ${result.output} ${result.stderr}`)
  }
  return status
}
