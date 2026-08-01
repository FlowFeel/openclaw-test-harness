/**
 * OpenRouter mock sidecar specs (Step 2 — DFT).
 *
 * Verifies the hermetic, offline LLM provider: ephemeral port binding (no
 * hardcoded 8080 race), fixed deterministic responses, and request capture.
 * The containerized E2E suite can point baseUrl at this server to run 100%
 * offline without live API keys or external network dependencies.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { OpenRouterMockServer } from "../../src/containers/openrouter-mock-sidecar.js"

describe("OpenRouterMockServer", () => {
  let server: OpenRouterMockServer

  beforeEach(() => {
    server = new OpenRouterMockServer() // port 0 = ephemeral
  })
  afterEach(async () => {
    await server.stop()
  })

  it("binds to an ephemeral port (no hardcoded 8080 race)", async () => {
    const port = await server.start()
    expect(port).toBeGreaterThan(0)
    expect(server.currentPort).toBe(port)
    // explicitly NOT 8080 — the anti-pattern we eliminated
    expect(port).not.toBe(8080)
  })

  it("serves a fixed OpenAI-compatible chat completion", async () => {
    const port = await server.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/@preset/glm-5-2", messages: [] }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe("gen-mock-12345")
    expect(json.choices[0].message.role).toBe("assistant")
    expect(json.choices[0].message.content).toBe("Mocked OpenRouter response")
  })

  it("captures every request in the log for deterministic assertions", async () => {
    const port = await server.start()
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
    })
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "y", messages: [] }),
    })
    expect(server.requestLog).toHaveLength(2)
    expect(server.requestLog[0].method).toBe("POST")
    expect(server.requestLog[0].url).toBe("/v1/chat/completions")
    expect((server.requestLog[0].body as { model: string }).model).toBe("x")
  })

  it("setResponse() overrides the fixed body", async () => {
    server.setResponse({
      id: "custom-1",
      choices: [{ message: { role: "assistant", content: "custom" } }],
    })
    const port = await server.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    const json = await res.json()
    expect(json.id).toBe("custom-1")
    expect(json.choices[0].message.content).toBe("custom")
  })

  it("stop() is idempotent and releases the port", async () => {
    await server.start()
    await server.stop()
    await server.stop() // no throw
    expect(server.currentPort).toBeNull()
  })
})
