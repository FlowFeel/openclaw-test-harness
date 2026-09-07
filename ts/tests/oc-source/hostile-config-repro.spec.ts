/**
 * Repro spec: does OC's config validation fail closed on hostile plugin config?
 *
 * Mirrors exactly what the boot-gate hostile-config scenario writes and what
 * `openclaw gateway run` does at startup (readConfigFileSnapshotWithPluginMetadata).
 * The plugin dir used is the harness's own oc-topic-manager (source layout).
 *
 * @dft
 * - Pure config validation against the real submodule code — no container.
 * - The gateway's config path is injected via OPENCLAW_CONFIG_PATH.
 */

import { describe, it, expect, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../..")
const OC_SRC = path.resolve(REPO_ROOT, "oc-source/upstream")
const OC_ROOT_DIR = path.resolve(OC_SRC, "src")

// The exact hostile config the boot-gate spec writes for oc-topic-manager.
const HOSTILE_CONFIG = {
  gateway: { mode: "local" },
  plugins: {
    load: { paths: [path.join(REPO_ROOT, "ts/src/plugins/oc-topic-manager")] },
    entries: {
      "oc-topic-manager": {
        enabled: true,
        config: { maxIdleDays: { nested: true }, maxMessages: "not-a-number" },
      },
    },
  },
}

const CONFIG_PATH = "/tmp/hostile-config-repro.json"

describe("Repro: OC config validation against hostile plugin config", () => {
  beforeAll(() => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(HOSTILE_CONFIG, null, 2))
    fs.mkdirSync("/tmp/fakehome-hostile-repro", { recursive: true })
  })

  it("readConfigFileSnapshotWithPluginMetadata returns valid=false with issues", async () => {
    const script = `
      import { readConfigFileSnapshotWithPluginMetadata } from "${OC_ROOT_DIR}/config/config.js"
      const result = await readConfigFileSnapshotWithPluginMetadata({})
      console.log("VALID:", result.snapshot.valid)
      console.log("ISSUES:", JSON.stringify(result.snapshot.issues ?? []))
      console.log("WARNINGS:", JSON.stringify(result.snapshot.warnings ?? []))
    `
    // Write script to a temp file to avoid quoting pain
    const scriptPath = "/tmp/repro-inner2.mts"
    fs.writeFileSync(scriptPath, script)

    const tsx = path.join(OC_SRC, "node_modules/.bin/tsx")
    const out = execFileSync(tsx, [scriptPath], {
      cwd: OC_SRC,
      encoding: "utf8",
      timeout: 180_000,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        HOME: "/tmp/fakehome-hostile-repro",
        XDG_CONFIG_HOME: "/tmp/fakehome-hostile-repro/.config",
      },
    })
    console.log(out)
    expect(out).toContain("VALID: false")
  }, 200_000)
})