import { describe, it, expect } from "vitest";
import {
  evaluatePayloadSpill,
  formatSpillPointerCard,
  inferSpillExtension,
} from "../../src/plugins/shared/payload-spill-logic.js";

describe("payload-spill-logic (Tier 1 Pure Logic)", () => {
  it("does not spill payloads under maxInlineBytes threshold", () => {
    const content = "Short output 123";
    const decision = evaluatePayloadSpill(content, "exec", { maxInlineBytes: 1000 });
    expect(decision.shouldSpill).toBe(false);
    expect(decision.totalBytes).toBe(16);
  });

  it("spills payloads exceeding maxInlineBytes threshold and extracts preview", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: some data content here`);
    const content = lines.join("\n");
    const decision = evaluatePayloadSpill(content, "exec", { maxInlineBytes: 500, maxPreviewLines: 5 });

    expect(decision.shouldSpill).toBe(true);
    expect(decision.totalBytes).toBeGreaterThan(500);
    expect(decision.preview.split("\n").length).toBe(5);
    expect(decision.inferredExtension).toBe("log");
  });

  it("infers EDN and JSON extensions correctly", () => {
    expect(inferSpillExtension("ast_parse", "{:type :root}")).toBe("edn");
    expect(inferSpillExtension("exec", "(+ 1 2)")).toBe("edn");
    expect(inferSpillExtension("read", '{"hello": "world"}')).toBe("json");
    expect(inferSpillExtension("exec", "plain terminal log")).toBe("log");
  });

  it("formats a deterministic in-transcript pointer card", () => {
    const card = formatSpillPointerCard({
      spillPath: "/tmp/openclaw-spill/sess-1/exec-123.log",
      totalBytes: 25000,
      preview: "Line 1\nLine 2",
      toolName: "exec",
    });

    expect(card).toContain("📦 [Large payload offloaded: 25000 bytes");
    expect(card).toContain("/tmp/openclaw-spill/sess-1/exec-123.log");
    expect(card).toContain("Preview:");
    expect(card).toContain("Line 1\nLine 2");
    expect(card).toContain('read(path="/tmp/openclaw-spill/sess-1/exec-123.log"');
  });
});
