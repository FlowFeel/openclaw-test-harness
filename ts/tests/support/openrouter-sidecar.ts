/**
 * OpenRouter mock sidecar container — testcontainers helper.
 *
 * Runs `openrouter-mock-sidecar.ts` as a long-lived container on a shared
 * testcontainers Network, reachable by sibling containers via the
 * `openrouter-mock` DNS alias. This is the "mock sidecar container" the
 * architectural review calls for: a deterministic, offline LLM provider
 * living inside the test environment, with no host networking and no
 * external network dependency.
 *
 * @invariants
 * - Image is stock `node:22-bookworm-slim` (zero node_modules — the sidecar
 *   uses only node:http / node:url builtins, loaded via --experimental-strip-types).
 * - Binds 0.0.0.0:9876 inside the container; siblings hit http://openrouter-mock:9876.
 * - Startup wait is the `[openrouter-mock] listening on 9876` log line.
 */
import {
  GenericContainer,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers"
import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Internal port the sidecar listens on (set via OPENROUTER_MOCK_PORT env). */
export const OPENROUTER_MOCK_PORT = 9876

/** DNS alias sibling containers use to reach the sidecar on the shared network. */
export const OPENROUTER_MOCK_ALIAS = "openrouter-mock"

export async function startOpenRouterSidecar(
  network: StartedNetwork,
): Promise<StartedTestContainer> {
  const sidecarPath = path.resolve(
    __dirname,
    "../../src/containers/openrouter-mock-sidecar.ts",
  )
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`OpenRouter mock sidecar source not found at ${sidecarPath}`)
  }

  return new GenericContainer("node:22-bookworm-slim")
    .withWorkingDir("/app")
    .withCopyFilesToContainer([
      { source: sidecarPath, target: "/app/sidecar.ts" },
    ])
    .withEnvironment({ OPENROUTER_MOCK_PORT: String(OPENROUTER_MOCK_PORT) })
    .withNetwork(network)
    .withNetworkAliases(OPENROUTER_MOCK_ALIAS)
    .withCommand(["node", "--experimental-strip-types", "/app/sidecar.ts"])
    .withWaitStrategy(Wait.forLogMessage("listening on"))
    .start()
}
