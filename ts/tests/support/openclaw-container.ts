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
   * against the mock sidecar over the shared Docker network. Present only when
   * started with `{ withSidecar: true }`.
   */
  executeModelCall?: (input: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => Promise<ModelCallResult>;
}

export interface StartPatchedOpenClawOptions {
  /**
   * When true, start an OpenRouter mock sidecar container on a shared
   * testcontainers Network, attach the OC container to it (alias `openclaw`),
   * set `OPENCLAW_OPENROUTER_BASE_URL` to point at the sidecar, and expose
   * `executeModelCall`. Reuse is disabled in this mode: the fresh per-run
   * Network would otherwise leave a reused container with stale attachments
   * from the previous run's (now-removed) network.
   */
  withSidecar?: boolean;
}

/** Short content hash of a file, for cache invalidation labels. */
function fileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

/**
 * True if a (reusable) container with this patch sha already exists — i.e. the
 * upcoming start will *reuse* it rather than create fresh. Best-effort: any error
 * (e.g. docker CLI unavailable) falls back to "unknown" so it never breaks tests.
 */
function existingContainerExists(sha: string): boolean | undefined {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=openclaw.patch.sha=${sha}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().length > 0;
  } catch {
    return undefined;
  }
}

export async function startPatchedOpenClaw(
  opts: StartPatchedOpenClawOptions = {},
): Promise<StartedOpenClawContainer> {
  // __dirname = ts/tests/support → up two levels lands on ts/ (where patches/ lives).
  const tsDir = path.resolve(__dirname, "../..");
  const patchPath = path.join(tsDir, "patches/child-admission.ts");

  // Fail fast with a clear error if the patch is missing. Otherwise testcontainers
  // silently copies nothing and the failure shows up as an opaque ERR_MODULE_NOT_FOUND
  // deep inside the container, which is very hard to debug.
  if (!fs.existsSync(patchPath)) {
    throw new Error(
      `Patch file not found at ${patchPath}. Resolved from __dirname=${__dirname}.`,
    );
  }

  // Content hash of the patch. testcontainers' reuse hash is built from `createOpts`,
  // which INCLUDES labels but NOT the contents of copied files. So we put the patch
  // sha in a label: editing the patch → new sha → new hash → fresh container is built
  // (no stale patch). Same patch → same hash → the stopped container is restarted in
  // ~1.5s instead of a ~4s cold create. Disable reuse in CI with
  // TESTCONTAINERS_REUSE_ENABLE=false to force fresh containers + Ryuk cleanup.
  const patchSha = fileSha256(patchPath);
  // Reuse is only enabled in the default (no-sidecar) path. The sidecar path
  // attaches a fresh per-run Network; testcontainers' reuseContainer only
  // *restarts* a matching stopped container — it does NOT re-connect networks —
  // so a reused OC container would keep stale attachments from the previous
  // run's (now-removed) network and could not reach the new sidecar. We force a
  // fresh create there and autoRemove on stop to avoid stopped-container pile-up.
  const reuseEnabled =
    !opts.withSidecar && process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";

  let network: StartedNetwork | undefined;
  let sidecar: StartedTestContainer | undefined;

  const builder = new GenericContainer("node:22-bookworm-slim")
    .withWorkingDir("/app")
    .withCopyFilesToContainer([
      {
        source: patchPath,
        target: "/app/child-admission.ts",
      },
    ])
    .withLabels({ "openclaw.patch.sha": patchSha })
    .withCommand(["tail", "-f", "/dev/null"]);

  if (opts.withSidecar) {
    // Sidecar path: hermetic, offline upstream. Start the mock OpenRouter on a
    // shared Docker network, then attach the OC container so an in-container
    // process can reach http://openrouter-mock:9876/v1 — exactly the baseUrl a
    // real OC subagent would call. Fresh per run (see reuseEnabled note above).
    network = await new Network().start();
    sidecar = await startOpenRouterSidecar(network);
    builder
      .withNetwork(network)
      .withNetworkAliases("openclaw")
      .withEnvironment({
        OPENCLAW_OPENROUTER_BASE_URL: `http://${OPENROUTER_MOCK_ALIAS}:${OPENROUTER_MOCK_PORT}/v1`,
      })
      .withAutoRemove(true);
  } else {
    // Reuse path: keep stopped containers so the next run can restart them.
    // autoRemove defaults to true, which makes stop() *remove* the container —
    // defeating reuse across runs. Set false so stop() only stops; the stopped
    // container is then restarted by the next run's withReuse() lookup.
    builder.withAutoRemove(false);
    if (reuseEnabled) {
      // Marks the container reusable: testcontainers looks up an existing (stopped)
      // container by hash, restarts it, and skips Ryuk tracking so it survives across
      // test runs. See testcontainers-node generic-container reuseOrStartContainer.
      builder.withReuse();
    }
  }

  const t0 = Date.now();
  const willReuse = reuseEnabled ? existingContainerExists(patchSha) : false;
  const container = await builder.start();
  const startedMs = Date.now() - t0;
  const how = willReuse === undefined ? "started" : willReuse ? "reused" : "created";
  console.log(
    `[openclaw-container] ${how} container in ${startedMs}ms` +
      ` (patch sha ${patchSha}, reuse=${reuseEnabled}, sidecar=${!!opts.withSidecar})`,
  );

  // Helper function to execute checks in the container environment
  const executeAdmissionCheck = async (params: any) => {
    const paramsStr = JSON.stringify(params).replace(/"/g, '\\"');
    
    // We execute Node with native --experimental-strip-types to load child-admission.ts
    // with zero dependencies or node_modules needed!
    const result = await container.exec([
      "node",
      "--experimental-strip-types",
      "-e",
      `
      import { resolveChildAdmission } from './child-admission.ts';
      console.log(JSON.stringify(resolveChildAdmission(JSON.parse("${paramsStr}"))));
      `
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to execute admission check in container: ${result.stderr}`);
    }
    return JSON.parse(result.stdout.trim());
  };

  // Pre-warm: the first `node --experimental-strip-types` exec in a cold/restarted
  // container is ~2s (cold page cache + module compile); warm execs are ~1.2s. Running
  // one throwaway check here moves that penalty out of the first test (which previously
  // flaked against the 5s default test timeout) and into beforeAll where it's expected.
  await executeAdmissionCheck({
    callerDepth: 0, maxSpawnDepth: 2, activeChildren: 0, maxActiveChildren: 2,
    globalActive: 0, maxConcurrent: 2, timedOutSubagents: [],
    runTimeoutSeconds: 300, collect: false,
  });

  // Drive an OpenRouter chat-completion call from inside the OC container against
  // the mock sidecar over the shared Docker network. The request body is base64-
  // encoded and passed as argv (not string-interpolated) to avoid the quote-
  // escaping fragility of executeAdmissionCheck's JSON.parse("...") embed — this
  // is robust to any model string or message content, including the worker-crash
  // payloads the fault-injection suite exercises.
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
          throw new Error(`Model call failed in container: ${result.stderr}`);
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
