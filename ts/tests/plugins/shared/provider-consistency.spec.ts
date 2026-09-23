/**
 * Unit tests for generic provider consistency logic (Issue #38).
 *
 * @dft
 * - Pure logic: zero fixtures, deterministic assertions.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateProviderConsistency,
  formatDoctorAssertionLine,
} from "../../../src/plugins/shared/provider-consistency.js";

describe("provider-consistency (generic boot-gate / doctor assertion)", () => {
  describe("compaction provider checks", () => {
    const compactionConfig = {
      capability: "compaction",
      configPath: "agents.defaults.compaction.provider",
      fallbackDescription: "built-in LLM summarizer",
      hazardNote: "wedges transcripts above ~5.2 MB (topic 70660)",
    };

    it("evaluates clean registered and selected provider as OK", () => {
      const assertion = evaluateProviderConsistency({
        ...compactionConfig,
        selectedId: "literate",
        registeredIds: ["literate", "streaming"],
      });

      expect(assertion.verdict).toBe("ok");
      expect(assertion.selectedId).toBe("literate");
      expect(assertion.message).toContain('compaction provider "literate" is configured and active');
      expect(assertion.consequence).toContain('plugin provider "literate" (registered)');
      expect(assertion.remediation).toBeUndefined();
    });

    it("evaluates registered but unselected provider as WARN (dead code hazard)", () => {
      const assertion = evaluateProviderConsistency({
        ...compactionConfig,
        selectedId: null,
        registeredIds: ["literate", "streaming"],
      });

      expect(assertion.verdict).toBe("warn");
      expect(assertion.selectedId).toBeNull();
      expect(assertion.message).toContain("UNSET although 2 provider(s) are registered");
      expect(assertion.message).toContain("registered provider is dead code");
      expect(assertion.consequence).toContain("unselected provider is dead code");
      expect(assertion.remediation).toContain('Set agents.defaults.compaction.provider to one of: "literate", "streaming"');
    });

    it("evaluates selected but unregistered provider as ERROR (wedge hazard)", () => {
      const assertion = evaluateProviderConsistency({
        ...compactionConfig,
        selectedId: "nonexistent-summarizer",
        registeredIds: ["literate", "streaming"],
      });

      expect(assertion.verdict).toBe("error");
      expect(assertion.selectedId).toBe("nonexistent-summarizer");
      expect(assertion.message).toContain('"nonexistent-summarizer" is configured but NOT registered');
      expect(assertion.consequence).toContain("fallback — unhandled selection");
      expect(assertion.remediation).toContain('change agents.defaults.compaction.provider to one of: "literate", "streaming"');
    });

    it("evaluates unset provider with no registered plugins as consistent baseline OK", () => {
      const assertion = evaluateProviderConsistency({
        ...compactionConfig,
        selectedId: undefined,
        registeredIds: [],
      });

      expect(assertion.verdict).toBe("ok");
      expect(assertion.selectedId).toBeNull();
      expect(assertion.message).toContain("clean default");
      expect(assertion.consequence).toContain("no custom providers registered — consistent");
    });
  });

  describe("generic contracts (memory and speech)", () => {
    it("evaluates memory provider selection correctly", () => {
      const assertion = evaluateProviderConsistency({
        capability: "memory",
        configPath: "agents.defaults.memory.provider",
        selectedId: null,
        registeredIds: ["vector-store"],
        fallbackDescription: "in-memory session buffer",
      });

      expect(assertion.verdict).toBe("warn");
      expect(assertion.message).toContain("agents.defaults.memory.provider is UNSET");
    });

    it("evaluates speech provider error when configured provider is missing", () => {
      const assertion = evaluateProviderConsistency({
        capability: "speech",
        configPath: "speech.provider",
        selectedId: "elevenlabs",
        registeredIds: ["system-tts"],
        fallbackDescription: "system text-to-speech",
      });

      expect(assertion.verdict).toBe("error");
      expect(assertion.message).toContain('speech.provider "elevenlabs" is configured but NOT registered');
    });
  });

  describe("doctor line formatting", () => {
    it("formats standardized doctor diagnostic lines with uppercase tags", () => {
      const okAssertion = evaluateProviderConsistency({
        capability: "compaction",
        configPath: "agents.defaults.compaction.provider",
        selectedId: "streaming",
        registeredIds: ["streaming"],
      });
      const warnAssertion = evaluateProviderConsistency({
        capability: "compaction",
        configPath: "agents.defaults.compaction.provider",
        selectedId: null,
        registeredIds: ["streaming"],
      });

      const okLine = formatDoctorAssertionLine(okAssertion);
      const warnLine = formatDoctorAssertionLine(warnAssertion);

      expect(okLine).toBe(
        `[doctor:provider-consistency] [OK   ] compaction: ${okAssertion.message}`
      );
      expect(warnLine).toBe(
        `[doctor:provider-consistency] [WARN ] compaction: ${warnAssertion.message}`
      );
    });
  });
});
