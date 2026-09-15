/**
 * Spec: Literate compaction algorithm (Axiom 1 & 2 compliant).
 *
 * @dft
 * - Pure: in-memory messages, zero file I/O, zero network calls.
 * - Deterministic: same transcript in -> identical markdown summary out.
 * - Verifies verbatim user preservation, flush-echo suppression, tool bloat removal.
 */

import { describe, it, expect } from "vitest";
import { compactLiterate } from "../../../src/plugins/oc-compaction-helper/src/literate-compaction-logic.js";

describe("compactLiterate (pure DFT compaction provider)", () => {
  it("preserves unique user prompts verbatim", () => {
    const messages = [
      { role: "user", content: "Please fix the caching bug in auth service." },
      { role: "assistant", content: "I am investigating the cache invalidation." },
      { role: "user", content: "Also make sure tests pass on Node 24." },
    ];

    const result = compactLiterate(messages);

    expect(result.preservedUserTurns).toBe(2);
    expect(result.summary).toContain("Please fix the caching bug in auth service.");
    expect(result.summary).toContain("Also make sure tests pass on Node 24.");
  });

  it("elides repetitive runtime-flush turns and duplicate prompts", () => {
    const messages = [
      { role: "user", content: "Deploy the new schema migration." },
      { role: "user", content: "Continue the OpenClaw runtime event for session 123" },
      { role: "user", content: "Continue the OpenClaw runtime event for session 123" },
      { role: "user", content: "Deploy the new schema migration." }, // exact duplicate
      { role: "assistant", content: "Migration completed." },
    ];

    const result = compactLiterate(messages);

    expect(result.preservedUserTurns).toBe(1);
    expect(result.elidedFlushTurns).toBe(3);
    expect(result.summary).not.toContain("Continue the OpenClaw runtime event");
  });

  it("strips heavy tool-result payloads and replaces with concise outcome lines", () => {
    // Simulate a massive 50KB tool payload
    const largeToolPayload = "x".repeat(50_000);
    const messages = [
      { role: "user", content: "Run git diff" },
      {
        role: "assistant",
        content: "Executing git diff",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "run_command", arguments: '{"command":"git diff"}' },
          },
        ],
      },
      { role: "tool", name: "run_command", content: largeToolPayload },
      { role: "assistant", content: "The diff shows 12 modified files." },
    ];

    const result = compactLiterate(messages);

    expect(result.strippedToolResults).toBe(1);
    expect(result.summary).toContain("[Tool Outcome] run_command completed");
    expect(result.summary).not.toContain(largeToolPayload);
    // Massive size reduction achieved
    expect(result.reductionPercent).toBeGreaterThanOrEqual(90);
    expect(result.compactedBytes).toBeLessThan(result.originalEstimatedBytes / 5);
  });

  it("truncates long assistant turns into clean semantic skeletons", () => {
    const longAssistantExplanation =
      "Beginning analysis.\n" +
      "First paragraph with lots of detailed reasoning and internal chain of thought.\n".repeat(20) +
      "Conclusion: the bug is in the token counter.";

    const messages = [
      { role: "user", content: "What is the problem?" },
      { role: "assistant", content: longAssistantExplanation },
    ];

    const result = compactLiterate(messages, { maxAssistantSkeletonChars: 250 });

    expect(result.summary).toContain("Beginning analysis.");
    expect(result.summary).toContain("truncated");
    expect(result.summary).toContain("the bug is in the token counter.");
  });

  it("rolls forward custom instructions and previous summaries", () => {
    const messages = [
      { role: "user", content: "Current status check." },
      { role: "assistant", content: "All services operating normally." },
    ];

    const result = compactLiterate(messages, {
      customInstructions: "Focus on database connection pool status.",
      previousSummary: "Prior turn confirmed redis migration succeeded.",
    });

    expect(result.summary).toContain("Focus on database connection pool status.");
    expect(result.summary).toContain("Prior turn confirmed redis migration succeeded.");
  });
});
