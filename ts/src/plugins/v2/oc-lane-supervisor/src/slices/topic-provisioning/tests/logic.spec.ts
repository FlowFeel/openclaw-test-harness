/**
 * Tier 1 Unit Spec: oc-lane-supervisor / topic-provisioning slice.
 *
 * @dft Pure unit tests — slugification, path derivation, and care package rendering.
 */

import { describe, it, expect } from "vitest";
import {
  slugifyTopicName,
  deriveTopicWorkspacePath,
  deriveCarePackagePath,
  renderCarePackageSkeleton,
} from "../logic.js";

describe("oc-lane-supervisor / slices/topic-provisioning (Tier 1 Unit)", () => {
  it("deterministically slugifies complex topic titles without inline regexes", () => {
    expect(slugifyTopicName("Docker E2E Test Harness & Plugin Suite")).toBe(
      "docker-e2e-test-harness-plugin-suite",
    );
    expect(slugifyTopicName("   Research Stable / Topic 90037   ")).toBe(
      "research-stable-topic-90037",
    );
    expect(slugifyTopicName("---Special!@#$%^&*()Chars---")).toBe("special-chars");
    expect(slugifyTopicName("   ")).toBe("unnamed-topic");
  });

  it("derives consistent topic workspace and care package paths", () => {
    const ws = deriveTopicWorkspacePath(83272, "Plugins Team", "/test/workspace");
    expect(ws).toBe("/test/workspace/work/topic-83272-plugins-team");

    const cp = deriveCarePackagePath("telegram:-1003842172831:topic:83272", 83272, "/test/workspace");
    expect(cp.relativePath).toBe("archive/sessions/telegram/1003842172831:topic:83272/topics/83272/care-package.md");
    expect(cp.absolutePath).toBe(
      "/test/workspace/archive/sessions/telegram/1003842172831:topic:83272/topics/83272/care-package.md",
    );
  });

  it("renders deterministic care-package skeleton markdown and turn-0 prompt summary", () => {
    const skeleton = renderCarePackageSkeleton({
      topicId: 83272,
      topicName: "Plugins Team",
      chatId: "telegram:-1003842172831:topic:83272",
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:83272",
      createdUtc: "2026-11-20T16:55:00Z",
      createdBy: "Ed Phil",
      generatedBy: "feelingflowingbot",
      workspaceRoot: "/home/node/.openclaw/workspace",
    });

    expect(skeleton.frontmatter).toContain('uri: topics/telegram:-1003842172831:topic:83272/83272/care-package');
    expect(skeleton.frontmatter).toContain('title: "Plugins Team"');
    expect(skeleton.frontmatter).toContain("topic_id: 83272");
    expect(skeleton.frontmatter).toContain('status: orientation');
    expect(skeleton.frontmatter).toContain('session_key: "agent:main:telegram:group:-1003842172831:topic:83272"');
    expect(skeleton.frontmatter).toContain('created_by: "Ed Phil"');
    expect(skeleton.frontmatter).toContain('generated_by: "feelingflowingbot"');

    expect(skeleton.markdown).toContain("## 1. Your Dedicated Workspace Directory");
    expect(skeleton.markdown).toContain("/home/node/.openclaw/workspace/work/topic-83272-plugins-team/");
    expect(skeleton.markdown).toContain("tools/CATALOG.md");
    expect(skeleton.markdown).toContain("Root Partition Warning");

    expect(skeleton.summaryInjection).toContain("[Topic Orientation]");
    expect(skeleton.summaryInjection).toContain("work/topic-83272-plugins-team");
  });

  it("handles null session keys deterministically and defaults provenance", () => {
    const skeleton = renderCarePackageSkeleton({
      topicId: 99999,
      topicName: "Unregistered Topic",
      chatId: "telegram:-1001234567890",
      sessionKey: null,
      createdUtc: "2026-11-20T17:00:00Z",
    });

    expect(skeleton.frontmatter).toContain('uri: topics/telegram:-1001234567890/99999/care-package');
    expect(skeleton.frontmatter).toContain("session_key: null");
    expect(skeleton.frontmatter).toContain('title: "Unregistered Topic"');
    expect(skeleton.frontmatter).toContain('created_by: "system"');
    expect(skeleton.frontmatter).toContain('generated_by: "flowfeel-oc-lane-supervisor@0.2.0"');
  });
});
