/**
 * Tier 2 Integration Spec: oc-lane-supervisor / topic-provisioning slice.
 *
 * @dft Integration tests with InMemoryPluginApi & InMemoryTopicProvisioningIO doubles.
 */

import { describe, it, expect } from "vitest";
import { bindTopicProvisioningSlice } from "../slice.js";
import { InMemoryTopicProvisioningIO } from "../io.js";
import type { PluginApi } from "../../../../../../shared/types.js";

function createMockApi(): PluginApi {
  return {
    on: () => {},
    registerTool: () => {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as PluginApi;
}

describe("oc-lane-supervisor / slices/topic-provisioning (Tier 2 Integration)", () => {
  it("provisions topic directory scaffolding and care-package.md on first agent run", () => {
    const api = createMockApi();
    const io = new InMemoryTopicProvisioningIO();
    const slice = bindTopicProvisioningSlice(api, {
      enabled: true,
      workspaceRoot: "/mock/workspace",
      io,
      clock: () => 1763657700000,
    });

    const event = { prompt: "Hello topic" };
    const ctx = {
      topicId: 83272,
      topicName: "Plugins Team",
      chatId: "telegram:-1003842172831:topic:83272",
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:83272",
    };

    const out = slice.onBeforeAgentRun(event, ctx);

    // Verify workspace scaffolding created
    expect(io.directories.has("/mock/workspace/work/topic-83272-plugins-team/docs")).toBe(true);
    expect(io.directories.has("/mock/workspace/work/topic-83272-plugins-team/scripts")).toBe(true);
    expect(io.directories.has("/mock/workspace/work/topic-83272-plugins-team/tests")).toBe(true);
    expect(io.directories.has("/mock/workspace/work/topic-83272-plugins-team/state")).toBe(true);

    // Verify care package file written
    const cpPath =
      "/mock/workspace/archive/sessions/telegram/1003842172831:topic:83272/topics/83272/care-package.md";
    expect(io.files.has(cpPath)).toBe(true);
    const content = io.files.get(cpPath) ?? "";
    expect(content).toContain('title: "Plugins Team"');
    expect(content).toContain("status: orientation");
    expect(content).toContain("tools/CATALOG.md");

    // Verify Turn 0 prompt injection
    expect(out.prompt).toContain("[Topic Orientation]");
    expect(out.prompt).toContain("Hello topic");
    expect(slice.isTopicProvisioned(83272)).toBe(true);
  });

  it("is strictly idempotent: does not re-write files on subsequent turns", () => {
    const api = createMockApi();
    const io = new InMemoryTopicProvisioningIO();
    const slice = bindTopicProvisioningSlice(api, {
      enabled: true,
      workspaceRoot: "/mock/workspace",
      io,
      clock: () => 1763657700000,
    });

    const event = { prompt: "Turn 1" };
    const ctx = { topicId: 83272, topicName: "Plugins Team" };

    slice.onBeforeAgentRun(event, ctx);
    const cpPath =
      "/mock/workspace/archive/sessions/telegram/default/topics/83272/care-package.md";
    expect(io.files.has(cpPath)).toBe(true);

    // Overwrite with marker to verify no re-writes occur
    io.files.set(cpPath, "MUTATED_CONTENT");

    const event2 = { prompt: "Turn 2" };
    slice.onBeforeAgentRun(event2, ctx);

    // Content should remain untouched
    expect(io.files.get(cpPath)).toBe("MUTATED_CONTENT");
  });

  it("ignores non-topic sessions gracefully", () => {
    const api = createMockApi();
    const io = new InMemoryTopicProvisioningIO();
    const slice = bindTopicProvisioningSlice(api, {
      enabled: true,
      workspaceRoot: "/mock/workspace",
      io,
    });

    const event = { prompt: "Main channel message" };
    const ctx = { sessionKey: "agent:main:telegram:direct:123" };

    const out = slice.onBeforeAgentRun(event, ctx);
    expect(out).toBe(event);
    expect(io.directories.size).toBe(0);
    expect(io.files.size).toBe(0);
  });
});
