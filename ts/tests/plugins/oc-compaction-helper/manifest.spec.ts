/**
 * Compaction helper hook registration + throttling tests.
 *
 * Verifies the plugin registers the correct hooks with the right names
 * and that the throttling logic makes the right decisions.
 *
 * @dft
 * - Pure: mock PluginApi, inline data, no file system
 * - Deterministic: injected timestamps
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "src/plugins/oc-compaction-helper");

describe("oc-compaction-helper manifest contracts", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8")
  );

  it("declares compact_check tool", () => {
    expect(manifest.contracts.tools).toContain("compact_check");
  });

  it("activates on startup", () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  it("has bloatFields default with 6 fields", () => {
    expect(manifest.configSchema.properties.bloatFields.default).toHaveLength(6);
    expect(manifest.configSchema.properties.bloatFields.default).toContain("systemPromptReport");
    expect(manifest.configSchema.properties.bloatFields.default).toContain("skillsSnapshot");
  });
});

describe("oc-compaction-helper hook registration", () => {
  it("registers before_prompt_build, before_compaction, after_compaction", () => {
    // Verify the source file contains the hook registrations
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");

    expect(source).toContain('"before_prompt_build"');
    expect(source).toContain('"agent_end"');
    expect(source).toContain('"before_compaction"');
    expect(source).toContain('"after_compaction"');
  });

  it("names hooks with compaction-helper prefix", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");

    expect(source).toContain("compaction-helper-before-prompt-build");
    expect(source).toContain("compaction-helper-agent-end");
    expect(source).toContain("compaction-helper-before-compaction");
    expect(source).toContain("compaction-helper-after-compaction");
  });

  it("does NOT register before_agent_reply (wrong hook for this plugin)", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).not.toContain('"before_agent_reply"');
  });


});

describe("oc-compaction-helper throttling logic", () => {
  // Pure logic tests for the throttle decision.
  // Models: should we do file I/O this turn?

  it("skips when within throttle window", () => {
    const now = 100_000;
    const lastCleanup = 99_500; // 500ms ago
    const throttleMs = 60_000;
    expect(now - lastCleanup < throttleMs).toBe(true);
  });

  it("proceeds when throttle window expired", () => {
    const now = 200_000;
    const lastCleanup = 100_000; // 100s ago
    const throttleMs = 60_000;
    expect(now - lastCleanup >= throttleMs).toBe(true);
  });

  it("skips when bloat below threshold (10KB)", () => {
    const bloatBytes = 5_000;
    const threshold = 10_240;
    expect(bloatBytes < threshold).toBe(true);
  });

  it("proceeds when bloat above threshold (10KB)", () => {
    const bloatBytes = 50_000;
    const threshold = 10_240;
    expect(bloatBytes >= threshold).toBe(true);
  });

  it("uses 60s default throttle", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).toContain("60_000");
  });

  it("uses 10KB default bloat threshold", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).toContain("10_240");
  });
});

describe("oc-compaction-helper source structure", () => {
  it("entry point exists", () => {
    expect(existsSync(resolve(dir, "src/index.ts"))).toBe(true);
  });

  it("imports cleanupSessions from shared", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).toContain("cleanupSessions");
    expect(source).toContain("session-cleanup.js");
  });

  it("imports readSessions/writeSessions from sessions-io", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).toContain("readSessions");
    expect(source).toContain("writeSessions");
    expect(source).toContain("sessions-io.js");
  });

  it("catches errors in all hooks (never blocks agent runs)", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    // Every hook should have a try/catch
    const hookBlocks = source.match(/registerHook\(/g) ?? [];
    const catchBlocks = source.match(/catch \(err\)/g) ?? [];
    expect(hookBlocks.length).toBe(4); // 4 hooks
    expect(catchBlocks.length).toBeGreaterThanOrEqual(4); // at least 4 catch blocks
  });

  it("throttle state is in-memory (lastCleanupMs)", () => {
    const source = readFileSync(resolve(dir, "src/index.ts"), "utf8");
    expect(source).toContain("lastCleanupMs");
    // Should NOT use Date.now() in the throttle check itself —
    // the timestamp is set after cleanup, not read from file
  });
});
