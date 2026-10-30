import { describe, it, expect } from "vitest";
import {
  truncateHeadTail,
  applyToolResultTruncation,
  formatOmissionNotice,
  OMISSION_NOTICE_PREFIX,
} from "../../../src/plugins/oc-session-guard/src/tool-result-hygiene-logic.js";
import {
  compactZeroDeltaPollMessage,
  evaluateMessageWriteSuppression,
  createInitialPollDeduplicationState,
  isZeroDeltaPollText,
  compactPollMarker,
} from "../../../src/plugins/oc-session-guard/src/poll-hygiene-logic.js";

describe("T-571: tool_result_persist hygiene logic", () => {
  it("preserves short tool result strings unchanged", () => {
    const text = "Short output of 100 characters.";
    const result = truncateHeadTail(text, { headChars: 800, tailChars: 800 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.omittedCount).toBe(0);
  });

  it("truncates oversized outputs preserving head 800 + tail 800 and notice", () => {
    const head = "H".repeat(800);
    const middle = "M".repeat(2000);
    const tail = "T".repeat(800);
    const fullText = `${head}${middle}${tail}`;

    const result = truncateHeadTail(fullText, { headChars: 800, tailChars: 800 });
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(2000);
    expect(result.text.startsWith(head)).toBe(true);
    expect(result.text.endsWith(tail)).toBe(true);
    expect(result.text).toContain("2000 characters truncated by oc-session-guard");
  });

  it("is idempotent when output was already truncated", () => {
    const alreadyTruncated = "Head\n\n[... 1500 characters truncated by oc-session-guard ...]\n\nTail";
    const result = truncateHeadTail(alreadyTruncated, { headChars: 10, tailChars: 10, maxToolResultChars: 20 });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(alreadyTruncated);
  });

  it("applies truncation to toolResult message content blocks", () => {
    const huge = "A".repeat(1000) + "B".repeat(1000) + "C".repeat(1000);
    const message = {
      role: "toolResult",
      toolName: "exec",
      content: [{ type: "text", text: huge }],
    };

    const res = applyToolResultTruncation(message, "exec", { headChars: 800, tailChars: 800 });
    expect(res.changed).toBe(true);
    const newText = (res.message.content as Array<{ text: string }>)[0].text;
    expect(newText).toContain("1400 characters truncated by oc-session-guard");
    expect(newText.startsWith("A".repeat(800))).toBe(true);
    expect(newText.endsWith("C".repeat(800))).toBe(true);
  });

  it("respects exemptTools list", () => {
    const huge = "A".repeat(5000);
    const message = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: huge }],
    };

    const res = applyToolResultTruncation(message, "read", {
      headChars: 800,
      tailChars: 800,
      exemptTools: ["read"],
    });
    expect(res.changed).toBe(false);
    expect((res.message.content as Array<{ text: string }>)[0].text).toBe(huge);
  });
});

describe("T-572: zero-delta poll de-duplication & frame suppression", () => {
  it("detects zero-delta poll text patterns", () => {
    expect(isZeroDeltaPollText("Process still running.")).toBe(true);
    expect(isZeroDeltaPollText("Output:\n(no new output)\n")).toBe(true);
    expect(isZeroDeltaPollText("Status: in_progress None")).toBe(true);
    expect(isZeroDeltaPollText("No new output for 5s; this session may be waiting for input")).toBe(true);
    expect(isZeroDeltaPollText("Build completed successfully in 12s")).toBe(false);
  });

  it("compacts multi-line zero-delta poll frame into single line marker", () => {
    const rawPoll = "Checking process...\n(no new output)\nProcess still running.\nWaiting for exit...";
    const message = {
      role: "toolResult",
      toolName: "process",
      details: { pid: 4812, sessionId: "sess-abc" },
      content: [{ type: "text", text: rawPoll }],
    };

    const res = compactZeroDeltaPollMessage(message, "process");
    expect(res.changed).toBe(true);
    expect(res.isZeroDelta).toBe(true);
    expect(res.message.content).toEqual([{ type: "text", text: "[poll: active pid=4812]" }]);
  });

  it("suppresses 50 consecutive identical poll frames down to 1 frame", () => {
    let state = createInitialPollDeduplicationState();
    const pollMessage = {
      role: "toolResult",
      toolName: "process",
      details: { pid: 1234 },
      content: [{ type: "text", text: "(no new output)\nProcess still running." }],
    };

    const writeResults: Array<{ block: boolean }> = [];

    for (let i = 0; i < 50; i++) {
      const decision = evaluateMessageWriteSuppression(pollMessage, state, "process");
      state = decision.nextState;
      writeResults.push({ block: decision.block });
    }

    const allowed = writeResults.filter((r) => !r.block);
    const blocked = writeResults.filter((r) => r.block);

    expect(allowed.length).toBe(1);
    expect(blocked.length).toBe(49);
    expect(state.suppressedPollCount).toBe(49);
  });

  it("resets suppression state when an active non-poll message arrives", () => {
    let state = createInitialPollDeduplicationState();
    const pollMessage = {
      role: "toolResult",
      toolName: "process",
      details: { pid: 1234 },
      content: [{ type: "text", text: "(no new output)" }],
    };

    // First poll: allowed
    let decision = evaluateMessageWriteSuppression(pollMessage, state, "process");
    state = decision.nextState;
    expect(decision.block).toBe(false);

    // Second poll: blocked
    decision = evaluateMessageWriteSuppression(pollMessage, state, "process");
    state = decision.nextState;
    expect(decision.block).toBe(true);

    // Normal message arrives
    const normalMessage = {
      role: "toolResult",
      toolName: "process",
      content: [{ type: "text", text: "Compilation finished with code 0" }],
    };
    decision = evaluateMessageWriteSuppression(normalMessage, state, "process");
    state = decision.nextState;
    expect(decision.block).toBe(false);
    expect(state.lastMessageIsZeroDeltaPoll).toBe(false);

    // Next poll should be allowed again as first in new sequence
    decision = evaluateMessageWriteSuppression(pollMessage, state, "process");
    state = decision.nextState;
    expect(decision.block).toBe(false);
  });
});
