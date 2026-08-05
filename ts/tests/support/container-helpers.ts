/**
 * Container helpers — shared utilities for all e2e tests.
 *
 * Every e2e test imports from here instead of creating containers directly.
 * This is the single point of control for container setup.
 */

export {
  startOpenClaw,
  startPatchedOpenClaw,
  type StartedOpenClawContainer,
  type StartOpenClawOptions,
} from "./openclaw-container.js";

export {
  startOpenRouterSidecar,
  OPENROUTER_MOCK_ALIAS,
  OPENROUTER_MOCK_PORT,
} from "./openrouter-sidecar.js";

// ── Shared constants ─────────────────────────────────────────────

export const OC_VERSION = "2026.6.8";

/** Repo paths — resolved once, used everywhere. */
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TS_DIR = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(TS_DIR, "..");
export const PLUGIN_DIR = path.resolve(TS_DIR, "src/plugins");
export const SHARED_DIR = path.resolve(TS_DIR, "src/plugins/shared");
export const OC_SOURCE = path.resolve(REPO_ROOT, "oc-source");
export const DOCKERFILE = path.resolve(REPO_ROOT, "docker/Dockerfile");

// ── Container exec helper ─────────────────────────────────────────

import type { StartedTestContainer } from "testcontainers";

/** Run a script inside a container and parse JSON output. */
export async function execInContainer(
  container: StartedTestContainer,
  script: string,
): Promise<any> {
  const result = await container.exec(["npx", "tsx", "-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(`Container exec failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  // Find the JSON line in output
  const lines = result.output.trim().split("\n");
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON in container output: ${result.output}`);
}
