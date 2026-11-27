/**
 * Unit Spec: Topic Routing & Flush Plan Resolver Pure Transition Algebra (Tier 1).
 *
 * @dft Pure unit tests against logic.ts functions with zero I/O and zero mocks.
 */

import { describe, it, expect } from "vitest";
import {
  parsePositiveTopicId,
  slugifyTopicName,
  deriveTopicMemoryPath,
  resolveMemoryFlushPlan,
  MEMORY_PROMPT_OBJECTIVES,
} from "../logic.js";

describe("topic-routing/logic (Pure Transition Algebra)", () => {
  describe("parsePositiveTopicId", () => {
    it("parses valid positive numbers and strings", () => {
      expect(parsePositiveTopicId(102248)).toBe(102248);
      expect(parsePositiveTopicId("102248")).toBe(102248);
      expect(parsePositiveTopicId("0")).toBeNull();
      expect(parsePositiveTopicId(-100)).toBeNull();
      expect(parsePositiveTopicId("invalid")).toBeNull();
      expect(parsePositiveTopicId(null)).toBeNull();
    });
  });

  describe("slugifyTopicName", () => {
    it("normalizes and slugifies forum topic names", () => {
      expect(slugifyTopicName("Cybernetics")).toBe("cybernetics");
      expect(slugifyTopicName("  Inferno & Purgatorio! ")).toBe("inferno-purgatorio");
      expect(slugifyTopicName("---weird---")).toBe("weird");
      expect(slugifyTopicName("")).toBe("unnamed-topic");
    });
  });

  describe("deriveTopicMemoryPath", () => {
    it("derives non-repeating topic memory paths under OWA", () => {
      const res = deriveTopicMemoryPath(102248, "Cybernetics");
      expect(res.targetDir).toBe("meta/memory/topics/102248-cybernetics");
      expect(res.targetPath).toBe("meta/memory/topics/102248-cybernetics/MEMORY.md");
      expect(res.topicSlug).toBe("cybernetics");

      // Redundant slug elimination
      const redundant = deriveTopicMemoryPath(102248, "topic-102248");
      expect(redundant.targetDir).toBe("meta/memory/topics/102248");
      expect(redundant.targetPath).toBe("meta/memory/topics/102248/MEMORY.md");
    });
  });

  describe("resolveMemoryFlushPlan", () => {
    const fixedIsoDate = "2026-11-26";

    it("routes Telegram topic session context to meta/memory/topics/<id>-<slug>/MEMORY.md", () => {
      const plan = resolveMemoryFlushPlan(
        {
          sessionKey: "agent:main:telegram:group:-1003842172831:topic:102248",
          topicName: "Cybernetics",
        },
        fixedIsoDate,
      );

      expect(plan.sessionType).toBe("topic");
      expect(plan.topicId).toBe(102248);
      expect(plan.topicSlug).toBe("cybernetics");
      expect(plan.targetPath).toBe("meta/memory/topics/102248-cybernetics/MEMORY.md");
      expect(plan.promptObjective).toBe(MEMORY_PROMPT_OBJECTIVES.TOPIC);
    });

    it("routes platform lane sessions to meta/team/SPEC_LOG.md", () => {
      const plan = resolveMemoryFlushPlan(
        { sessionKey: "agent:main:platform:core", lane: "platform" },
        fixedIsoDate,
      );

      expect(plan.sessionType).toBe("platform");
      expect(plan.targetPath).toBe("meta/team/SPEC_LOG.md");
      expect(plan.promptObjective).toBe(MEMORY_PROMPT_OBJECTIVES.PLATFORM);
    });

    it("routes user direct sessions to meta/memory/<user>/MEMORY.md", () => {
      const plan = resolveMemoryFlushPlan(
        { sessionKey: "agent:main:direct:edphos" },
        fixedIsoDate,
      );

      expect(plan.sessionType).toBe("user");
      expect(plan.user).toBe("edphos");
      expect(plan.targetPath).toBe("meta/memory/edphos/MEMORY.md");
      expect(plan.promptObjective).toBe(MEMORY_PROMPT_OBJECTIVES.USER);
    });

    it("falls back to memory/YYYY-MM-DD.md when unscoped", () => {
      const plan = resolveMemoryFlushPlan({}, fixedIsoDate);

      expect(plan.sessionType).toBe("fallback");
      expect(plan.targetPath).toBe("memory/2026-11-26.md");
      expect(plan.promptObjective).toBe(MEMORY_PROMPT_OBJECTIVES.FALLBACK);
    });
  });
});
