/**
 * OpenRouter mock sidecar — containerized, offline E2E.
 *
 * Verifies the sidecar runs as a real long-lived container on a shared
 * testcontainers Network and serves the fixed OpenAI-compatible response to a
 * *separate* client container over the Docker network — 100% offline, no host
 * networking, no external API keys, no hardcoded host port.
 *
 * This closes the gap between Step 2 (OpenRouter mock sidecar) and the
 * testcontainers E2E layer: a containerized agent process can reach a
 * deterministic upstream provider without touching the real OpenRouter API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  Network,
  GenericContainer,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers"
import {
  startOpenRouterSidecar,
  OPENROUTER_MOCK_PORT,
  OPENROUTER_MOCK_ALIAS,
} from "../support/openrouter-sidecar.js"

describe("OpenRouter mock sidecar — containerized offline E2E", () => {
  let network: StartedNetwork
  let sidecar: StartedTestContainer
  let client: StartedTestContainer

  beforeAll(async () => {
    network = await new Network().start()
    sidecar = await startOpenRouterSidecar(network)
    // A separate client container on the same network — stands in for the
    // containerized OC agent process that would call baseUrl in production.
    client = await new GenericContainer("node:22-bookworm-slim")
      .withNetwork(network)
      .withCommand(["tail", "-f", "/dev/null"])
      .start()
  }, 120000)

  afterAll(async () => {
    await client?.stop().catch(() => {})
    await sidecar?.stop().catch(() => {})
    await network?.stop().catch(() => {})
  })

  it("client container fetches the fixed OpenRouter response from the sidecar over the Docker network", async () => {
    const script = `(async () => {
      const res = await fetch("http://${OPENROUTER_MOCK_ALIAS}:${OPENROUTER_MOCK_PORT}/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openrouter/@preset/glm-5-2", messages: [] }),
      });
      const json = await res.json();
      console.log(JSON.stringify({
        status: res.status,
        id: json.id,
        role: json.choices[0].message.role,
        content: json.choices[0].message.content,
      }));
    })();`
    const result = await client.exec(["node", "-e", script])

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout.trim())
    expect(parsed.status).toBe(200)
    expect(parsed.id).toBe("gen-mock-12345")
    expect(parsed.role).toBe("assistant")
    expect(parsed.content).toBe("Mocked OpenRouter response")
  })

  it("sidecar is long-lived: serves a second request from the client (not one-shot)", async () => {
    const result = await client.exec([
      "node",
      "-e",
      `(async () => {
        const res = await fetch("http://${OPENROUTER_MOCK_ALIAS}:${OPENROUTER_MOCK_PORT}/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "x", messages: [] }),
        });
        console.log(res.status);
      })();`,
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("200")
  })

  it("sidecar returns the identical fixed response regardless of request payload (deterministic)", async () => {
    // The in-process requestLog lives in the sidecar container's memory and is
    // not exposed over HTTP; deterministic request capture is asserted in the
    // integration spec. Here we assert the sidecar returns the same fixed
    // response for an arbitrary model string — proving determinism regardless
    // of request payload.
    const result = await client.exec([
      "node",
      "-e",
      `(async () => {
        const res = await fetch("http://${OPENROUTER_MOCK_ALIAS}:${OPENROUTER_MOCK_PORT}/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openrouter/anthropic/claude-3.5-sonnet", messages: [{ role: "user", content: "ping" }] }),
        });
        const json = await res.json();
        console.log(json.id + "|" + json.choices[0].message.content);
      })();`,
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("gen-mock-12345|Mocked OpenRouter response")
  })
})
