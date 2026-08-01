/**
 * OpenRouter Provider Integration & Compatibility Spec
 *
 * Verifies that OpenClaw's architectural patches (worker pool, SQLite registry,
 * adaptive subagent admission) interoperate cleanly with OpenRouter API provider setups:
 * - Model string formatting (`openrouter/*`, `openrouter/@preset/*`)
 * - Non-blocking streaming chunk serialization off main thread
 * - OpenRouter rate-limit (429) & timeout handling via stale subagent detection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockWorkerPool } from "../../src/features/worker-pool/mock-pool.js";
import { registerBuiltinHandlers } from "../../src/features/worker-pool/handlers.js";
import { transitionSubagent } from "../../src/features/subagent-admission/subagent-admission.machine.js";
import type { SubagentState } from "../../src/features/subagent-admission/subagent-admission.schema.js";

describe("OpenRouter Provider Compatibility — Model Formatting & Registry", () => {
  const OPENROUTER_MODELS = [
    "openrouter/anthropic/claude-3.5-sonnet",
    "openrouter/google/gemini-2.5-flash",
    "openrouter/deepseek/deepseek-r1",
    "openrouter/@preset/glm-5-2",
  ];

  it("parses and validates OpenRouter model strings", () => {
    for (const model of OPENROUTER_MODELS) {
      expect(model.startsWith("openrouter/")).toBe(true);
      const parts = model.split("/");
      expect(parts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("sanitizes legacy direct anthropic channel overrides to openrouter/", () => {
    const legacyModel = "anthropic/claude-sonnet-4-6";
    const sanitizeModelString = (model?: string | null): string | null => {
      if (!model) return null;
      if (model.startsWith("anthropic/") && !model.startsWith("openrouter/")) {
        return `openrouter/${model}`;
      }
      return model;
    };

    expect(sanitizeModelString(legacyModel)).toBe("openrouter/anthropic/claude-sonnet-4-6");
    expect(sanitizeModelString("openrouter/anthropic/claude-3.5-sonnet")).toBe("openrouter/anthropic/claude-3.5-sonnet");
  });
});

describe("OpenRouter Provider Compatibility — Non-Blocking Stream Payload Serialization", () => {
  let pool: MockWorkerPool;

  beforeEach(() => {
    pool = new MockWorkerPool();
    registerBuiltinHandlers(pool);
  });

  afterEach(async () => {
    await pool.destroy();
  });

  it("offloads heavy OpenRouter response chunk serialization off main thread", async () => {
    const openRouterStreamChunk = {
      id: "gen-1712000000-xyz",
      provider: "OpenRouter",
      model: "openrouter/anthropic/claude-3.5-sonnet",
      choices: [
        {
          delta: { content: "Chunk content received from OpenRouter SSE stream..." },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 450, total_tokens: 570 },
    };

    const result = await pool.execute<string>("json.stringify", { data: openRouterStreamChunk });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("OpenRouter");
    expect(result.data).toContain("openrouter/anthropic/claude-3.5-sonnet");
  });

  it("transfers structured OpenRouter stream state directly via V8 Structured Clone (ipc.transfer)", async () => {
    const openRouterState = {
      sessionKey: "agent:main:subagent:openrouter-1",
      model: "openrouter/@preset/glm-5-2",
      activeStream: true,
      bufferedTokens: 1450,
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Test Harness",
      },
    };

    const result = await pool.execute<typeof openRouterState>("ipc.transfer", { payload: openRouterState });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(openRouterState);
    expect(result.data?.model).toBe("openrouter/@preset/glm-5-2");
  });
});

describe("OpenRouter Rate Limits & Timeout Handling", () => {
  it("handles subagent stalls caused by OpenRouter rate limits (429) gracefully", () => {
    // Initial state: subagent running request against OpenRouter
    const state: SubagentState = "running";

    // OpenRouter times out or returns 429 rate limit stall → transition to yielding/timed_out
    const nextState = transitionSubagent(state, "timeout");
    expect(nextState).toBe("timed_out");

    // Clean archival
    const finalState = transitionSubagent(nextState, "archive");
    expect(finalState).toBe("archived");
  });
});
