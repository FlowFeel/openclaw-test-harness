/**
 * Container helpers — shared setup for all e2e tests.
 *
 * One image (docker/Dockerfile), volume mounts for code, content-hash
 * reuse. All e2e tests go through this — no ad-hoc container creation.
 */

import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  startOpenRouterSidecar,
  OPENROUTER_MOCK_ALIAS,
  OPENROUTER_MOCK_PORT,
} from "./openrouter-sidecar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Paths ────────────────────────────────────────────────────────

const TS_DIR = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(TS_DIR, "..");
const DOCKERFILE = path.resolve(REPO_ROOT, "docker/Dockerfile");
const OC_SOURCE = path.resolve(REPO_ROOT, "oc-source");

// ── Types ────────────────────────────────────────────────────────

export interface ModelCallResult {
  status: number;
  id: string;
  role: string;
  content: string;
}

export interface StartedOpenClawContainer {
  container: StartedTestContainer;
  executeAdmissionCheck: (params: any) => Promise<any>;
  /** Present only when started with `{ withSidecar: true }`. */
  sidecar?: StartedTestContainer;
  /** Present only when started with `{ withSidecar: true }`. */
  network?: StartedNetwork;
  /**
   * Drive an OpenRouter chat-completion call from inside the OC container
   * against the mock sidecar over the shared Docker network.
   */
  executeModelCall?: (input: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => Promise<ModelCallResult>;
}

export interface StartOpenClawOptions {
  /** Start an OpenRouter mock sidecar on a shared network. */
  withSidecar?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Content hash of a directory — for container reuse labels. */
function dirSha256(dir: string): string {
  if (!fs.existsSync(dir)) return "none";
  const hash = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
}

/** Check if a reusable container exists (best-effort). */
function existingContainerExists(label: string): boolean {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=${label}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Start an OC test container from docker/Dockerfile.
 *
 * - OC + tsx are baked into the image (no runtime npm install).
 * - Plugin source and oc-source submodule are volume-mounted.
 * - Content-hash label enables reuse across test runs.
 * - Patches are applied at image build time (not runtime).
 */
export async function startOpenClaw(
  opts: StartOpenClawOptions = {},
): Promise<StartedOpenClawContainer> {
  const pluginSha = dirSha256(path.resolve(TS_DIR, "src/plugins"));

  let network: StartedNetwork | undefined;
  let sidecar: StartedTestContainer | undefined;

  // Build the image from our Dockerfile — OC + tsx baked in.
  // build() returns a GenericContainer we can configure directly.
  const containerBuilder = await GenericContainer.fromDockerfile(REPO_ROOT, "docker/Dockerfile")
    .withBuildkit()
    .withCache(true)
    .build();

  containerBuilder
    .withWorkingDir("/app")
    .withLabels({
      "openclaw.plugins.sha": pluginSha,
      "oc.version": "2026.6.8",
    })
    .withBindMounts([
      { source: TS_DIR, target: "/app/ts" },
      { source: OC_SOURCE, target: "/app/oc-source" },
    ])
    .withCommand(["tail", "-f", "/dev/null"]);

  if (opts.withSidecar) {
    network = await new Network().start();
    sidecar = await startOpenRouterSidecar(network);
    containerBuilder
      .withNetwork(network)
      .withNetworkAliases("openclaw")
      .withEnvironment({
        OPENCLAW_OPENROUTER_BASE_URL: `http://${OPENROUTER_MOCK_ALIAS}:${OPENROUTER_MOCK_PORT}/v1`,
      })
      .withAutoRemove(true);
  } else {
    containerBuilder.withAutoRemove(false);
    const reuseEnabled = process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";
    if (reuseEnabled && existingContainerExists(`openclaw.plugins.sha=${pluginSha}`)) {
      containerBuilder.withReuse();
    }
  }

  const t0 = Date.now();
  const container = await containerBuilder.start();
  const startedMs = Date.now() - t0;
  console.log(
    `[container] started in ${startedMs}ms (plugins sha ${pluginSha}, sidecar=${!!opts.withSidecar})`,
  );

  // Execute admission check helper
  const executeAdmissionCheck = async (params: any) => {
    const paramsStr = JSON.stringify(params).replace(/"/g, '\\"');
    const result = await container.exec([
      "npx", "tsx", "-e",
      `import { resolveChildAdmission } from './ts/patches/child-admission.ts';
       console.log(JSON.stringify(resolveChildAdmission(JSON.parse("${paramsStr}"))));`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Admission check failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout.trim());
  };

  // Pre-warm
  await executeAdmissionCheck({
    callerDepth: 0, maxSpawnDepth: 2, activeChildren: 0, maxActiveChildren: 2,
    globalActive: 0, maxConcurrent: 2, timedOutSubagents: [],
    runTimeoutSeconds: 300, collect: false,
  });

  // Model call helper (sidecar mode only)
  const executeModelCall = opts.withSidecar
    ? async (input: {
        model: string;
        messages: Array<{ role: string; content: string }>;
      }): Promise<ModelCallResult> => {
        const b64 = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
        const script = `
          const baseUrl = process.env.OPENCLAW_OPENROUTER_BASE_URL;
          const body = Buffer.from(process.argv[1], "base64").toString("utf8");
          const res = await fetch(baseUrl + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const json = await res.json();
          console.log(JSON.stringify({
            status: res.status,
            id: json.id,
            role: json.choices[0].message.role,
            content: json.choices[0].message.content,
          }));
        `;
        const result = await container.exec(["node", "-e", script, b64]);
        if (result.exitCode !== 0) {
          throw new Error(`Model call failed: ${result.stderr}`);
        }
        return JSON.parse(result.stdout.trim());
      }
    : undefined;

  return {
    container,
    executeAdmissionCheck,
    sidecar,
    network,
    executeModelCall,
  };
}

// ── Backward compat: re-export old name ──────────────────────────

export { startOpenClaw as startPatchedOpenClaw };
export type { StartOpenClawOptions as StartPatchedOpenClawOptions };
