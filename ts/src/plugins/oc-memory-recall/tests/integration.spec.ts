/**
 * oc-memory-recall integration test — wiring + Protocol doubles (DFT Axiom 5).
 */

import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import type { RawNoteFile, MemoryNotesLoader } from "../src/memory-recall-io.js";
import type { PluginApi, ToolDefinition } from "../../shared/types.js";

class FakePluginApiClient {
  public tools = new Map<string, ToolDefinition>();
  public hooks = new Map<string, (event: unknown, ctx?: unknown) => unknown>();

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  on(hook: string, handler: (event: unknown, ctx?: unknown) => unknown): void {
    this.hooks.set(hook, handler);
  }
}

class FakeNotesLoaderClient {
  public files: RawNoteFile[] = [];

  getLoader(): MemoryNotesLoader {
    return (_notesDir: string) => this.files;
  }
}

const SAMPLE_NOTE_FILE: RawNoteFile = {
  id: "architecture-rule.md",
  filePath: "memory/architecture-rule.md",
  rawContent: `---
kind: architectural_decision
use_when: Changing authentication or session token lifecycle
does_not_apply_when: UI styling changes
provenance: "Architecture Review 2026-10-15 / 1d"
source: "src/auth/tokens.ts"
title: "Token Expiry Invariants"
paths:
  - "src/auth/tokens.ts"
  - "src/auth/session.ts"
---
# Token Rules
Session tokens expire after 3600 seconds.
`,
};

describe("oc-memory-recall integration", () => {
  it("registers expected hooks and tools", () => {
    const api = new FakePluginApiClient();
    plugin.register(api as unknown as PluginApi, {});

    expect(Array.from(api.hooks.keys())).toEqual([
      "gateway_start",
      "tool_result_persist",
    ]);
    expect(Array.from(api.tools.keys())).toEqual([
      "recall_status",
      "recall_verify",
    ]);
  });

  it("indexes notes at gateway_start and reports status via recall_status", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    const startHook = api.hooks.get("gateway_start");
    expect(startHook).toBeDefined();
    await startHook!({});

    const statusTool = api.tools.get("recall_status");
    expect(statusTool).toBeDefined();
    const result = await statusTool!.execute("call-1", {});
    expect(result.content[0].text).toContain("ok: notes: 1 total (1 valid, 0 invalid)");
    expect(result.content[0].text).toContain("1 kinds");
  });

  it("injects M6 marker on file reads in tool_result_persist and updates telemetry", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    // Boot gateway to index notes
    await api.hooks.get("gateway_start")!({});

    // Simulate tool_result_persist on reading "src/auth/tokens.ts"
    const persistHook = api.hooks.get("tool_result_persist");
    expect(persistHook).toBeDefined();

    const toolEvent = {
      toolName: "view_file",
      params: { AbsolutePath: "/workspace/src/auth/tokens.ts" },
      message: {
        role: "tool",
        content: "export const TOKEN_LIFETIME = 3600;",
      },
    };

    const outcome = (await persistHook!(toolEvent)) as { message: { content: string } };
    expect(outcome).toBeDefined();
    expect(outcome.message.content).toContain("# [SIGNPOST] May be out of date; the current version is kept in memory: src/auth/tokens.ts");
    expect(outcome.message.content).toContain("export const TOKEN_LIFETIME = 3600;");

    // Check telemetry updated via recall_status
    const statusTool = api.tools.get("recall_status")!;
    const statusResult = await statusTool.execute("call-2", {});
    expect(statusResult.content[0].text).toContain("[architectural_decision][M6]: fired=1 hit=1 followed=0");
  });

  it("handles structured array message content in tool_result_persist", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    const persistHook = api.hooks.get("tool_result_persist")!;
    const toolEvent = {
      toolName: "read_file",
      params: { path: "src/auth/session.ts" },
      message: {
        role: "tool",
        content: [{ type: "text", text: "export class Session {}" }],
      },
    };

    const outcome = (await persistHook(toolEvent)) as {
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(outcome).toBeDefined();
    expect(outcome.message.content[0].text).toContain("# [SIGNPOST] May be out of date");
    expect(outcome.message.content[0].text).toContain("export class Session {}");
  });

  it("recall_verify reports verification diagnostics", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [
      SAMPLE_NOTE_FILE,
      {
        id: "bad.md",
        filePath: "memory/bad.md",
        rawContent: "No frontmatter block",
      },
    ];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    const verifyTool = api.tools.get("recall_verify")!;
    const verifyResult = await verifyTool.execute("call-3", { reload: false });
    expect(verifyResult.content[0].text).toContain("failed: verified 2 notes: 1 valid, 1 invalid");
    expect(verifyResult.content[0].text).toContain("bad.md");
  });
});
