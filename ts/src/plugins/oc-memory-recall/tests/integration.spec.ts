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
  public enqueuedInjections: Array<{ sessionKey?: string; text: string; idempotencyKey?: string }> = [];

  public session = {
    workflow: {
      enqueueNextTurnInjection: async (params: { sessionKey?: string; text: string; idempotencyKey?: string }) => {
        this.enqueuedInjections.push(params);
        return { enqueued: true, id: `inj-${this.enqueuedInjections.length}` };
      },
    },
  };

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
      "after_tool_call",
      "before_agent_reply",
    ]);
    expect(Array.from(api.tools.keys())).toEqual([
      "recall_status",
      "recall_verify",
      "recall_catalogue",
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


  it("boot-flood guard: passes subdirs to the loader and filters non-kind files before parsing", async () => {
    const api = new FakePluginApiClient();
    const seen: Array<{ dir: string; subdirs?: string[] }> = [];
    const dailyLog: RawNoteFile = {
      id: "2026-06-12.md",
      filePath: "memory/2026-06-12.md",
      rawContent: "---\ndate: 2026-06-12\nsessions: 1\n---\n# Daily log\n episodic content\n",
    };
    const noFrontmatter: RawNoteFile = {
      id: "INDEX.md",
      filePath: "memory/INDEX.md",
      rawContent: "# Index\nplain markdown, no frontmatter\n",
    };
    const loader: MemoryNotesLoader = (dir, subdirs) => {
      seen.push({ dir, subdirs });
      return [SAMPLE_NOTE_FILE, dailyLog, noFrontmatter];
    };
    plugin.register(api as unknown as PluginApi, {
      notesLoader: loader,
      subdirs: ["authoritative"],
    });

    const start = api.hooks.get("gateway_start") as (e?: unknown, c?: unknown) => Promise<void>;
    await start(undefined, undefined);

    // Loader received the configured subdirs
    expect(seen.length).toBe(1);
    expect(seen[0].subdirs).toEqual(["authoritative"]);

    // Registry holds only the kind-bearing authoritative note — the daily log
    // and the plain markdown file never enter indexing.
    const status = await api.tools.get("recall_status")!.execute("t1", {});
    const text = (status as { content: Array<{ type: string; text: string }> }).content
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("1 total (1 valid, 0 invalid)");
    expect(text).not.toContain("unknown");
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

  it("enqueues M1 event push on after_tool_call and honors hold-once policy", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    const afterToolCall = api.hooks.get("after_tool_call")!;
    expect(afterToolCall).toBeDefined();

    // 1. Tool call matches note's paths
    await afterToolCall(
      {
        toolName: "edit_file",
        params: { path: "src/auth/session.ts" },
        result: "updated",
      },
      { sessionKey: "session-42" },
    );

    const m1Injections = api.enqueuedInjections.filter((inj) =>
      inj.text.includes("# [MEMORY CUE]"),
    );
    expect(m1Injections).toHaveLength(1);
    expect(m1Injections[0].sessionKey).toBe("session-42");
    expect(m1Injections[0].text).toContain("src/auth/tokens.ts");
    expect(m1Injections[0].idempotencyKey).toContain("m1-hold-session-42-");

    // 2. Second tool call in same session -> hold-once suppresses duplicate
    await afterToolCall(
      {
        toolName: "edit_file",
        params: { path: "src/auth/session.ts" },
        result: "updated again",
      },
      { sessionKey: "session-42" },
    );

    const m1InjectionsAfter = api.enqueuedInjections.filter((inj) =>
      inj.text.includes("# [MEMORY CUE]"),
    );
    expect(m1InjectionsAfter).toHaveLength(1); // Still 1

    // 3. Telemetry reflects M1 fired and hit
    const statusTool = api.tools.get("recall_status")!;
    const statusResult = await statusTool.execute("call-telemetry", {});
    expect(statusResult.content[0].text).toContain("M1");
  });

  it("enqueues M5 resume refresh on gateway_start for authority notes", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE]; // architectural_decision kind

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    // M5 refresh injection was queued
    expect(api.enqueuedInjections.length).toBeGreaterThanOrEqual(1);
    const m5Injection = api.enqueuedInjections.find((inj) =>
      inj.text.includes("# [MEMORY RESUME REFRESH]"),
    );
    expect(m5Injection).toBeDefined();
    expect(m5Injection!.text).toContain("src/auth/tokens.ts");
  });

  it("recall_catalogue returns structured one-line catalogue (M7)", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    const catalogueTool = api.tools.get("recall_catalogue")!;
    expect(catalogueTool).toBeDefined();

    const result = await catalogueTool.execute("call-cat", {});
    expect(result.content[0].text).toContain("# [MEMORY CATALOGUE] 1 of 1 memory notes:");
    expect(result.content[0].text).toContain("[architectural_decision]");
    expect(result.content[0].text).toContain("Token Expiry Invariants");
  });

  it("intercepts reply in before_agent_reply and appends missing signposts (M4 Linter)", async () => {
    const api = new FakePluginApiClient();
    const loaderClient = new FakeNotesLoaderClient();
    loaderClient.files = [SAMPLE_NOTE_FILE];

    plugin.register(api as unknown as PluginApi, {
      notesLoader: loaderClient.getLoader(),
    });

    await api.hooks.get("gateway_start")!({});

    const beforeReplyHook = api.hooks.get("before_agent_reply")!;
    expect(beforeReplyHook).toBeDefined();

    // 1. Reply mentioning tracked path 'src/auth/tokens.ts' without signpost
    const rawReply = "I have modified src/auth/tokens.ts to use 1800s expiry.";
    const result1 = (await beforeReplyHook({ cleanedBody: rawReply })) as {
      handled: boolean;
      reply: { text: string };
    };

    expect(result1).toBeDefined();
    expect(result1.handled).toBe(true);
    expect(result1.reply.text).toContain("[Memory Notice: Path 'src/auth/tokens.ts' governed by architectural_decision: src/auth/tokens.ts]");

    // 2. Reply that already includes signpost -> untouched
    const compliantReply = "Updated per src/auth/tokens.ts authority note.";
    const result2 = await beforeReplyHook({ cleanedBody: compliantReply });
    expect(result2).toBeUndefined();
  });

  it("Schema v2 integration: recall_verify surfaces prose pointer, predicate lint errors and warnings", async () => {
    const api = new FakePluginApiClient();
    const badV2Note: RawNoteFile = {
      id: "bad-v2.md",
      filePath: "memory/bad-v2.md",
      rawContent: `---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "src/style.ts"
paths:
  - "all files in repo"
predicate: "always follow instructions. Do not deviate"
updated: "not-iso-date"
event: "lint fails"
---
# Bad Note Content
`,
    };
    const loader: MemoryNotesLoader = () => [badV2Note];
    plugin.register(api as unknown as PluginApi, { notesLoader: loader });

    const verifyTool = api.tools.get("recall_verify")!;
    const result = await verifyTool.execute("c1", {});
    const text = result.content[0].text;
    expect(text).toContain("failed:");
    expect(text).toContain("prose/URI pointer");
    expect(text).toContain("sentence-internal period");
    expect(text).toContain("imperative mood");
    expect(text).toContain("warnings");
    expect(text).toContain("not a valid ISO 8601 date string");
  });

  it("Schema v2 integration: tool_result_persist emits three-slot cue for v2 notes and suppresses skip-list notes", async () => {
    const api = new FakePluginApiClient();
    const v2ClaimNote: RawNoteFile = {
      id: "v2-claim.md",
      filePath: "memory/v2-claim.md",
      rawContent: `---
kind: house_style
use_when: Writing plugins
does_not_apply_when: Writing tests
provenance: "2026-10-18"
source: "src/auth/jwt.ts"
title: "JWT Invariants"
predicate: "changed since this summary: pure logic required"
---
# JWT Rules
`,
    };
    const skipListNote: RawNoteFile = {
      id: "v2-skip.md",
      filePath: "memory/v2-skip.md",
      rawContent: `---
kind: procedure
use_when: running tests
does_not_apply_when: deploy
provenance: "2026-10-18"
source: "src/auth/tests.ts"
predicate: "step 1"
---
# Procedure
`,
    };
    const loader: MemoryNotesLoader = () => [v2ClaimNote, skipListNote];
    plugin.register(api as unknown as PluginApi, { notesLoader: loader });

    const persistHook = api.hooks.get("tool_result_persist");

    // 1. Reading file tracked by v2 claim note
    const event1 = {
      toolName: "read_file",
      params: { path: "src/auth/jwt.ts" },
      message: { content: "original jwt content" },
    };
    const outcome1 = (await persistHook!(event1)) as { message: { content: string } };
    expect(outcome1).toBeDefined();
    expect(outcome1.message.content).toContain(
      "changed since this summary: pure logic required: JWT Invariants — see src/auth/jwt.ts"
    );

    // 2. Reading file tracked only by skip-list note -> suppressed, untouched (returns undefined)
    const event2 = {
      toolName: "read_file",
      params: { path: "src/auth/tests.ts" },
      message: { content: "original test content" },
    };
    const outcome2 = await persistHook!(event2);
    expect(outcome2).toBeUndefined();
  });
});

