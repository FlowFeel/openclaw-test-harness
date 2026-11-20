/**
 * Tier 4 E2E Boot Gate — all 4 v2 domain engines must boot cleanly together
 * inside a REAL containerized OpenClaw gateway.
 *
 * @invariants
 * - No mocks: real `openclaw gateway run`, real `plugins.load.paths`, real
 *   vertical-slice `register()` wiring, real HTTP listener (A5).
 *
 * @dft
 * - Runs in Docker-enabled CI (`vitest.config.docker.ts`) as Tier 4 of the
 *   Phosphene test pyramid.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  startOpenClaw,
  type StartedOpenClawContainer,
} from "../support/openclaw-container.js";
import {
  bootGateway,
  builtV2PluginDirs,
  probeGateway,
  stagePluginDirs,
  PLUGINS_SRC_DIR,
} from "../support/gateway-boot.js";

const distMarker = path.join(PLUGINS_SRC_DIR, "v2", "oc-model-nexus", "dist", "index.js");
const toContainerPath = (hostDir: string) => hostDir.replace(/^.*\/ts\//, "/app/ts/");

let env: StartedOpenClawContainer;
let v2Dirs: string[];
let v2Ids: string[];
let port = 19101;

beforeAll(async () => {
  if (!fs.existsSync(distMarker)) {
    execFileSync("npm", ["run", "build:plugins"], {
      cwd: path.join(PLUGINS_SRC_DIR, "..", ".."),
      stdio: "inherit",
    });
  }
  env = await startOpenClaw();
  const hostDirs = builtV2PluginDirs();
  expect(hostDirs.length).toBe(4);
  v2Ids = hostDirs.map(
    (d) => JSON.parse(fs.readFileSync(path.join(d, "openclaw.plugin.json"), "utf8")).id as string,
  );
  v2Dirs = await stagePluginDirs(env.container, hostDirs.map(toContainerPath));
}, 180_000);

afterAll(async () => {
  if (env?.container) await env.container.stop();
});

describe("Tier 4 E2E: all 4 v2 domain engines boot in a real OpenClaw gateway", () => {
  it("Scenario: all 4 v2 engines boot together and answer HTTP health probes", async () => {
    const entries = Object.fromEntries(v2Ids.map((id) => [id, { enabled: true }]));
    const gw = await bootGateway({
      container: env.container,
      pluginDirs: v2Dirs,
      port: port++,
      entries,
    });
    try {
      expect(gw.ready, gw.log).toBe(true);
      const status = await probeGateway(env.container, port - 1);
      expect(status).toBeGreaterThanOrEqual(200);
      expect(status).toBeLessThan(500);
    } finally {
      await gw.stop();
    }
  }, 60_000);
});
