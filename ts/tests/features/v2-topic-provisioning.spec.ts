/**
 * Tier 3 BDD Spec: v2-topic-provisioning.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemoryPluginApi and InMemoryTopicProvisioningIO.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-lane-supervisor/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";
import { InMemoryTopicProvisioningIO } from "../../src/plugins/v2/oc-lane-supervisor/src/slices/topic-provisioning/io.js";

describe("Feature: Plugins v2 Topic Provisioning — Automated Workspace Scaffolding & Care Package Drop", () => {
  it("Scenario: New forum topic agent run automatically provisions workspace and drops orientation care package", async () => {
    const api = new InMemoryPluginApi();
    const io = new InMemoryTopicProvisioningIO();

    pluginDef.register(api, {
      enableTopicProvisioning: true,
      topicProvisioningIO: io,
      workspaceRoot: "/workspace",
      clock: () => 1763658000000,
    });

    const ctx = {
      topicId: 83272,
      topicName: "Plugins Team",
      chatId: "telegram:-1003842172831:topic:83272",
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:83272",
    };

    const [gateDecision] = await api.dispatchHook(
      "before_agent_run",
      { prompt: "Kick off sprint", channelId: "telegram" },
      ctx,
    );

    // before_agent_run MUST return strict OpenClaw InputGateDecision ({ outcome: "pass" })
    expect(gateDecision).toEqual({ outcome: "pass" });

    // Assert workspace scaffolding created
    expect(io.directories.has("/workspace/work/topic-83272-plugins-team/docs")).toBe(true);
    expect(io.directories.has("/workspace/work/topic-83272-plugins-team/scripts")).toBe(true);
    expect(io.directories.has("/workspace/work/topic-83272-plugins-team/tests")).toBe(true);
    expect(io.directories.has("/workspace/work/topic-83272-plugins-team/state")).toBe(true);

    // Assert care package created
    const carePackagePath =
      "/workspace/archive/sessions/telegram/1003842172831:topic:83272/topics/83272/care-package.md";
    expect(io.files.has(carePackagePath)).toBe(true);
    const content = io.files.get(carePackagePath) ?? "";
    expect(content).toContain('title: "Plugins Team"');
    expect(content).toContain("status: orientation");
    expect(content).toContain("tools/CATALOG.md");

    // Assert Turn 0 orientation brief delivered via before_prompt_build prependContext
    const [promptResult] = await api.dispatchHook(
      "before_prompt_build",
      { prompt: "Kick off sprint" },
      ctx,
    );
    const prependContext = (promptResult as { prependContext?: string })?.prependContext ?? "";
    expect(prependContext).toContain("[Topic Orientation]");
    expect(prependContext).toContain("work/topic-83272-plugins-team");
  });

  it("Scenario: Subsequent agent turns in provisioned topic are idempotent", async () => {
    const api = new InMemoryPluginApi();
    const io = new InMemoryTopicProvisioningIO();

    pluginDef.register(api, {
      enableTopicProvisioning: true,
      topicProvisioningIO: io,
      workspaceRoot: "/workspace",
    });

    const ctx = { topicId: 83272, topicName: "Plugins Team" };

    // Turn 1
    await api.dispatchHook("before_agent_run", { prompt: "Turn 1" }, ctx);
    const carePackagePath =
      "/workspace/archive/sessions/telegram/default/topics/83272/care-package.md";
    expect(io.files.has(carePackagePath)).toBe(true);

    // Mutate marker
    io.files.set(carePackagePath, "SENTINEL");

    // Turn 2
    await api.dispatchHook("before_agent_run", { prompt: "Turn 2" }, ctx);
    expect(io.files.get(carePackagePath)).toBe("SENTINEL");
  });
});
