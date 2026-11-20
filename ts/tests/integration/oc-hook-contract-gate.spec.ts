/**
 * OpenClaw Hook-Contract Integration Gate — proves all 4 v2 domain engines
 * conform strictly to OpenClaw's real hook runner contracts and NEVER break
 * interactive Telegram/user messaging.
 *
 * @why
 * OpenClaw's `before_agent_run` hook (`oc-source/upstream/src/plugins/hooks.ts`)
 * is a fail-closed InputGateDecision gate: ANY handler returning `undefined`,
 * `null`, `{ block: true }`, a mutated event object, or throwing an exception
 * causes OpenClaw to reject the message with:
 *   "Your message could not be sent: blocked by <pluginId>"
 *
 * This integration gate loads ALL 4 v2 engines simultaneously on a shared
 * PluginApi (matching production gateway topology), replays real interactive
 * Telegram, redacted-prompt, media-only, topic-Turn-0, and hostile-I/O turns,
 * and validates every hook return value against OpenClaw's exact `isHookDecision`
 * contract (importing OpenClaw's real `isHookDecision` when the upstream
 * submodule is present in Docker Integration / local dev).
 *
 * @dft
 * - A5: Uses stateful InMemoryPluginApi and InMemoryTopicProvisioningIO — zero mocks.
 * - A6: Asserts exact OpenClaw hook decision contracts for every lifecycle step.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import laneSupervisor from "../../src/plugins/v2/oc-lane-supervisor/src/index.js";
import memoryNexus from "../../src/plugins/v2/oc-memory-nexus/src/index.js";
import modelNexus from "../../src/plugins/v2/oc-model-nexus/src/index.js";
import taskPlane from "../../src/plugins/v2/oc-task-plane/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";
import { InMemoryTopicProvisioningIO } from "../../src/plugins/v2/oc-lane-supervisor/src/slices/topic-provisioning/io.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_HOOK_DECISION_PATH = path.resolve(
  __dirname,
  "../../../oc-source/upstream/src/plugins/hook-decision-types.ts",
);

/**
 * Exact mirror of OpenClaw's `isHookDecision` from
 * `oc-source/upstream/src/plugins/hook-decision-types.ts`.
 */
function mirrorIsHookDecision(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (v.outcome === "pass") return keys.length === 1;
  if (v.outcome !== "block") return false;
  const allowed = new Set(["outcome", "reason", "message", "category", "metadata"]);
  if (keys.some((k) => !allowed.has(k))) return false;
  if (typeof v.reason !== "string" || !v.reason.trim()) return false;
  if ("message" in v && (typeof v.message !== "string" || !v.message.trim())) return false;
  if ("category" in v && (typeof v.category !== "string" || !v.category.trim())) return false;
  if (
    "metadata" in v &&
    (typeof v.metadata !== "object" || v.metadata === null || Array.isArray(v.metadata))
  ) {
    return false;
  }
  return true;
}

async function loadOcIsHookDecision(): Promise<(value: unknown) => boolean> {
  if (fs.existsSync(UPSTREAM_HOOK_DECISION_PATH)) {
    const mod = (await import(pathToFileURL(UPSTREAM_HOOK_DECISION_PATH).href)) as {
      isHookDecision?: (value: unknown) => boolean;
    };
    if (typeof mod.isHookDecision === "function") {
      return mod.isHookDecision;
    }
  }
  return mirrorIsHookDecision;
}

function registerAllV2Engines(opts?: {
  topicProvisioningIO?: InMemoryTopicProvisioningIO;
}): InMemoryPluginApi {
  const api = new InMemoryPluginApi();
  laneSupervisor.register(api, {
    enableTopicProvisioning: true,
    topicProvisioningIO: opts?.topicProvisioningIO ?? new InMemoryTopicProvisioningIO(),
    workspaceRoot: "/mem/workspace",
    sessionsReader: () => ({}),
    sessionsWriter: () => {},
  });
  memoryNexus.register(api, {
    sessionsReader: () => ({}),
    sessionsWriter: () => {},
  });
  modelNexus.register(api, {});
  taskPlane.register(api, {
    reader: () => ({ version: 1, tasks: {} }),
    writer: () => {},
  });
  return api;
}

describe("OpenClaw Hook-Contract Integration Gate (All 4 v2 Engines)", () => {
  it("admits normal interactive Telegram messages without fail-closed blocking", async () => {
    const isHookDecision = await loadOcIsHookDecision();
    const api = registerAllV2Engines();

    const results = await api.dispatchHook(
      "before_agent_run",
      {
        prompt: "Check production status",
        messages: [],
        channelId: "telegram",
        senderId: "12345",
      },
      { sessionId: "tg-main", channelId: "telegram", chatId: "telegram:-1001" },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const decision of results) {
      expect(isHookDecision(decision)).toBe(true);
      expect(decision).toEqual({ outcome: "pass" });
    }
  });

  it("admits Telegram messages when prompt is redacted (undefined) or empty media/attachment", async () => {
    const isHookDecision = await loadOcIsHookDecision();
    const api = registerAllV2Engines();

    // Case 1: allowPromptContent not enabled -> prompt omitted/undefined
    const redactedResults = await api.dispatchHook(
      "before_agent_run",
      { messages: [], channelId: "telegram", senderId: "12345" },
      { sessionId: "tg-redacted" },
    );
    for (const decision of redactedResults) {
      expect(isHookDecision(decision)).toBe(true);
      expect(decision).toEqual({ outcome: "pass" });
    }

    // Case 2: photo/sticker/voice message with empty string prompt on Telegram
    const mediaResults = await api.dispatchHook(
      "before_agent_run",
      { prompt: "", messages: [], channelId: "telegram", senderId: "12345" },
      { sessionId: "tg-media" },
    );
    for (const decision of mediaResults) {
      expect(isHookDecision(decision)).toBe(true);
      expect(decision).toEqual({ outcome: "pass" });
    }
  });

  it("admits Telegram forum topic Turn 0 even when provisioning disk I/O fails (fail-open)", async () => {
    const isHookDecision = await loadOcIsHookDecision();
    const brokenIo = new InMemoryTopicProvisioningIO();
    brokenIo.mkdirSync = () => {
      throw new Error("EACCES: permission denied");
    };
    const api = registerAllV2Engines({ topicProvisioningIO: brokenIo });

    const results = await api.dispatchHook(
      "before_agent_run",
      { prompt: "Hello new topic", messages: [], channelId: "telegram", senderId: "12345" },
      {
        sessionId: "tg-topic-999",
        topicId: 999,
        topicName: "Ops",
        chatId: "telegram:-100123",
      },
    );

    for (const decision of results) {
      expect(isHookDecision(decision)).toBe(true);
      expect(decision).toEqual({ outcome: "pass" });
    }
  });

  it("returns valid InputGateDecision block (never malformed) for idle heartbeat suppression", async () => {
    const isHookDecision = await loadOcIsHookDecision();
    const api = registerAllV2Engines();

    const results = await api.dispatchHook(
      "before_agent_run",
      { prompt: "[OpenClaw heartbeat poll] If nothing needs attention, reply HEARTBEAT_OK", messages: [] },
      { sessionId: "hb-1", trigger: "heartbeat", isHeartbeat: true },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const decision of results) {
      expect(isHookDecision(decision)).toBe(true);
    }
    expect(
      results.some(
        (d) => typeof d === "object" && d !== null && (d as { outcome?: string }).outcome === "block",
      ),
    ).toBe(true);
  });

  it("completes a full interactive Telegram turn lifecycle across all 4 v2 engines without throwing or blocking", async () => {
    const isHookDecision = await loadOcIsHookDecision();
    const api = registerAllV2Engines();
    const ctx = {
      sessionId: "tg-full-turn",
      sessionKey: "agent:main:telegram:group:-1001:topic:42",
      channelId: "telegram",
      chatId: "telegram:-1001",
      topicId: 42,
      topicName: "Integration Gate",
    };

    // 1. before_dispatch
    await expect(
      api.dispatchHook("before_dispatch", { content: "Summarize build", sessionKey: ctx.sessionKey }, ctx),
    ).resolves.toBeDefined();

    // 2. before_agent_run (must return strict { outcome: "pass" })
    const runDecisions = await api.dispatchHook(
      "before_agent_run",
      { prompt: "Summarize build", messages: [], channelId: "telegram", senderId: "u1" },
      ctx,
    );
    for (const d of runDecisions) {
      expect(isHookDecision(d)).toBe(true);
      expect(d).toEqual({ outcome: "pass" });
    }

    // 3. before_prompt_build (must not throw; Turn 0 orientation delivered cleanly)
    const promptBuilds = await api.dispatchHook(
      "before_prompt_build",
      { prompt: "Summarize build", messages: [] },
      ctx,
    );
    expect(
      promptBuilds.some(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as { prependContext?: string }).prependContext === "string" &&
          (r as { prependContext: string }).prependContext.includes("[Topic Orientation]"),
      ),
    ).toBe(true);

    // 4. before_tool_call (normal tool call must NOT be blocked)
    const toolGates = await api.dispatchHook(
      "before_tool_call",
      { toolName: "exec", params: { command: "echo ok" } },
      ctx,
    );
    for (const g of toolGates) {
      expect((g as { block?: boolean } | undefined)?.block).not.toBe(true);
    }

    // 5. tool_result_persist & before_message_write & agent_end
    await expect(
      api.dispatchHook(
        "tool_result_persist",
        { toolName: "exec", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
        ctx,
      ),
    ).resolves.toBeDefined();

    const writeResults = await api.dispatchHook(
      "before_message_write",
      { message: { role: "assistant", content: [{ type: "text", text: "Build is green." }] } },
      ctx,
    );
    for (const w of writeResults) {
      expect((w as { block?: boolean } | undefined)?.block).not.toBe(true);
    }

    await expect(
      api.dispatchHook("agent_end", { producedVisibleReply: true }, ctx),
    ).resolves.toBeDefined();
  });
});
