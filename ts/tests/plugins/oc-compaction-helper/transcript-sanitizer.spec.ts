import { describe, it, expect } from "vitest";
import { sanitizeTranscriptLines } from "../../../src/plugins/oc-compaction-helper/src/transcript-sanitizer-logic.js";

describe("T-575: In-situ transcript compaction & sanitization", () => {
  it("collapses 1,000 synthetic zero-delta poll frames down to 1 frame while preserving conversation turns", () => {
    const lines: string[] = [];

    // Initial user turn
    lines.push(JSON.stringify({ role: "user", content: "Build the Docker image and deploy" }));

    // Initial assistant turn
    lines.push(JSON.stringify({ role: "assistant", content: "Starting build process..." }));

    // Tool call message
    lines.push(JSON.stringify({
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "exec", arguments: { command: "docker build ." } }],
    }));

    // 1,000 consecutive zero-delta poll frames
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({
        role: "toolResult",
        toolName: "process",
        details: { pid: 4812, sessionId: "sess-abc" },
        content: `Checking pid 4812 (step ${i})...\n(no new output)\nProcess still running.`,
      }));
    }

    // Final successful build result (oversized)
    const bigSuccessLog = "Build Step 1: OK\n" + "X".repeat(3000) + "\nSuccessfully tagged image: app:v2";
    lines.push(JSON.stringify({
      role: "toolResult",
      toolName: "process",
      content: bigSuccessLog,
    }));

    // Final assistant turn
    lines.push(JSON.stringify({ role: "assistant", content: "Deployment finished successfully." }));

    expect(lines.length).toBe(1005);

    const { sanitizedLines, report } = sanitizeTranscriptLines(lines, { headChars: 800, tailChars: 800 });

    // Expect 999 poll frames suppressed
    expect(report.suppressedPollFrames).toBe(999);
    // User turn, assistant turn, tool call, 1 compacted poll, 1 final tool result, 1 final assistant turn = 6
    expect(sanitizedLines.length).toBe(6);
    expect(report.reductionPercent).toBeGreaterThan(90);

    // Verify turns intact
    const parsedSanitized = sanitizedLines.map((l) => JSON.parse(l));
    expect(parsedSanitized[0].role).toBe("user");
    expect(parsedSanitized[0].content).toBe("Build the Docker image and deploy");

    expect(parsedSanitized[1].role).toBe("assistant");
    expect(parsedSanitized[1].content).toBe("Starting build process...");

    expect(parsedSanitized[2].role).toBe("assistant");
    expect(parsedSanitized[2].toolCalls[0].name).toBe("exec");

    // The single remaining poll frame is compacted
    expect(parsedSanitized[3].role).toBe("toolResult");
    expect(parsedSanitized[3].content).toBe("[poll: active pid=4812]");

    // The final big log was truncated cleanly
    expect(parsedSanitized[4].role).toBe("toolResult");
    expect(parsedSanitized[4].content).toContain("characters truncated by oc-session-guard");

    // Final assistant response preserved
    expect(parsedSanitized[5].role).toBe("assistant");
    expect(parsedSanitized[5].content).toBe("Deployment finished successfully.");
  });

  it("deduplicates repeated identical tool errors", () => {
    const lines: string[] = [
      JSON.stringify({ role: "user", content: "Check health" }),
      JSON.stringify({ role: "toolResult", toolName: "exec", isError: true, content: "Error: connect ECONNREFUSED 127.0.0.1:8080" }),
      JSON.stringify({ role: "toolResult", toolName: "exec", isError: true, content: "Error: connect ECONNREFUSED 127.0.0.1:8080" }),
      JSON.stringify({ role: "toolResult", toolName: "exec", isError: true, content: "Error: connect ECONNREFUSED 127.0.0.1:8080" }),
      JSON.stringify({ role: "assistant", content: "Service is down." }),
    ];

    const { sanitizedLines, report } = sanitizeTranscriptLines(lines);
    expect(report.deduplicatedErrors).toBe(2);
    expect(sanitizedLines.length).toBe(3);
  });
});
