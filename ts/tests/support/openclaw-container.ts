import { GenericContainer, StartedTestContainer } from "testcontainers";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StartedOpenClawContainer {
  container: StartedTestContainer;
  executeAdmissionCheck: (params: any) => Promise<any>;
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

export async function startPatchedOpenClaw(): Promise<StartedOpenClawContainer> {
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
  const reuseEnabled = process.env.TESTCONTAINERS_REUSE_ENABLE !== "false";

  const builder = new GenericContainer("node:22-bookworm-slim")
    .withWorkingDir("/app")
    .withCopyFilesToContainer([
      {
        source: patchPath,
        target: "/app/child-admission.ts",
      },
    ])
    .withLabels({ "openclaw.patch.sha": patchSha })
    // autoRemove defaults to true, which makes stop() *remove* the container —
    // defeating reuse across runs. Set false so stop() only stops; the stopped
    // container is then restarted by the next run's withReuse() lookup.
    .withAutoRemove(false)
    .withCommand(["tail", "-f", "/dev/null"]);

  if (reuseEnabled) {
    // Marks the container reusable: testcontainers looks up an existing (stopped)
    // container by hash, restarts it, and skips Ryuk tracking so it survives across
    // test runs. See testcontainers-node generic-container reuseOrStartContainer.
    builder.withReuse();
  }

  const t0 = Date.now();
  const willReuse = reuseEnabled ? existingContainerExists(patchSha) : false;
  const container = await builder.start();
  const startedMs = Date.now() - t0;
  const how = willReuse === undefined ? "started" : willReuse ? "reused" : "created";
  console.log(
    `[openclaw-container] ${how} container in ${startedMs}ms` +
      ` (patch sha ${patchSha}, reuse=${reuseEnabled})`,
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

  return {
    container,
    executeAdmissionCheck,
  };
}
