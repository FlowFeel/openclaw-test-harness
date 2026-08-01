/**
 * OpenClaw + OpenRouter mock sidecar — wired-in containerized E2E.
 *
 * Verifies the full containerized path the architectural review calls for: a
 * patched OpenClaw container, attached to the same Docker network as the mock
 * OpenRouter sidecar, can (1) run admission guards and (2) drive a real
 * chat-completion call against the deterministic offline upstream — no live
 * API keys, no external network, no hardcoded host port.
 *
 * This is the spawn → LLM-call flow exercised containerized and 100% offline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  startPatchedOpenClaw,
  type StartedOpenClawContainer,
} from "../support/openclaw-container.js"

describe("OpenClaw + OpenRouter mock sidecar (wired-in containerized E2E)", () => {
  let env: StartedOpenClawContainer

  beforeAll(async () => {
    env = await startPatchedOpenClaw({ withSidecar: true })
  }, 120000)

  afterAll(async () => {
    // sidecar path is autoRemove=true, so stop() reclaims the OC container.
    await env?.container?.stop().catch(() => {})
    await env?.sidecar?.stop().catch(() => {})
    await env?.network?.stop().catch(() => {})
  })

  it("admission still admits a healthy spawn with the sidecar network attached", async () => {
    const result = await env.executeAdmissionCheck({
      callerDepth: 0,
      maxSpawnDepth: 2,
      activeChildren: 0,
      maxActiveChildren: 2,
      globalActive: 0,
      maxConcurrent: 2,
      timedOutSubagents: [],
      runTimeoutSeconds: 300,
      collect: false,
    })
    expect(result.ok).toBe(true)
  })

  it("drives an OpenRouter chat-completion call from inside the OC container against the mock sidecar", async () => {
    const result = await env.executeModelCall!({
      model: "openrouter/@preset/glm-5-2",
      messages: [{ role: "user", content: "ping" }],
    })
    expect(result.status).toBe(200)
    expect(result.id).toBe("gen-mock-12345")
    expect(result.role).toBe("assistant")
    expect(result.content).toBe("Mocked OpenRouter response")
  })

  it("full offline flow: admit spawn → model call succeeds against the sidecar", async () => {
    // 1. Admission gate (patched child-admission) admits the spawn.
    const admit = await env.executeAdmissionCheck({
      callerDepth: 0,
      maxSpawnDepth: 2,
      activeChildren: 0,
      maxActiveChildren: 2,
      globalActive: 0,
      maxConcurrent: 2,
      timedOutSubagents: [],
      runTimeoutSeconds: 300,
      collect: false,
    })
    expect(admit.ok).toBe(true)

    // 2. The spawned agent calls its configured OpenRouter baseUrl, which
    //    resolves to the mock sidecar over the shared Docker network.
    const call = await env.executeModelCall!({
      model: "openrouter/anthropic/claude-3.5-sonnet",
      messages: [
        { role: "user", content: "containerized + offline + deterministic" },
      ],
    })
    expect(call.status).toBe(200)
    expect(call.content).toBe("Mocked OpenRouter response")
  })

  it("sidecar is long-lived across multiple model calls from the OC container", async () => {
    for (let i = 0; i < 3; i++) {
      const call = await env.executeModelCall!({
        model: "openrouter/@preset/glm-5-2",
        messages: [{ role: "user", content: `turn ${i}` }],
      })
      expect(call.status).toBe(200)
      expect(call.id).toBe("gen-mock-12345")
    }
  })
})
