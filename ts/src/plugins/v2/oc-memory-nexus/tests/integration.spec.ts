/**
 * Tier 2 Integration Spec: oc-memory-nexus (Stateful Protocol Doubles, Axiom A5).
 *
 * @dft Zero vi.fn() shims — verifies REAL compact_check, compact_delta, sanitize_transcript,
 * recall_*, and sidecar_* execution via InMemory* Protocol doubles.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../src/index.js";
import { InMemoryPluginApi } from "../../../../../tests/doubles/in-memory-plugin-api.js";
import {
  InMemorySessionsStore,
  InMemorySidecarClient,
  InMemoryTranscriptStore,
} from "../../../../../tests/doubles/in-memory-io.js";
import type { RawNoteFile } from "../src/memory-recall-io.js";

const SAMPLE_NOTES: RawNoteFile[] = [
  {
    id: "user-prefs",
    filePath: "memory/user-prefs.md",
    rawContent:
      "---\nkind: user_preference\nevent: format_report\nuse_when: formatting replies\n" +
      "does_not_apply_when: raw json\nprovenance: interview\nsource: memory/user-prefs.md\n---\nConcise.",
  },
];

describe("oc-memory-nexus (Tier 2 Integration)", () => {
  it("executes real compaction check, M8 delta, transcript sanitization, recall, and sidecar tools", async () => {
    const api = new InMemoryPluginApi();
    const sessions = new InMemorySessionsStore({
      "agent:main:s1": { sessionId: "s1", updatedAt: 1000, payload: "x".repeat(20_000) } as never,
    });
    const transcripts = new InMemoryTranscriptStore({
      "/mem/s1.jsonl": [
        JSON.stringify({ role: "user", content: "check status" }),
        JSON.stringify({ role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] }),
        JSON.stringify({ role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] }),
      ],
    });
    const sidecar = new InMemorySidecarClient();
    sidecar.setPostResponse("/exec/json.stringify", { json: '{"ok":true}' });

    let mtimes: Record<string, number> = { "spec.md": 100 };
    let now = 10_000;

    pluginDef.register(api, {
      notesLoader: () => SAMPLE_NOTES,
      sessionsReader: sessions.read,
      mtimeReader: () => ({ ...mtimes }),
      transcriptPathResolver: (key: string) => (key === "s1" ? "/mem/s1.jsonl" : null),
      transcriptReader: transcripts.read,
      transcriptWriter: transcripts.write,
      sidecarClient: sidecar,
      autoCompactionThresholdMb: 0.01,
      clock: () => now,
    });

    await api.dispatchHook("gateway_start");
    await api.dispatchHook("before_compaction");

    // 1. Real compact_check evaluates live session byte size
    const check = JSON.parse((await api.executeTool("compact_check")).content[0].text);
    expect(check.ok).toBe(true);
    expect(check.shouldTrigger).toBe(true);
    expect(check.recommendation).toBe("compact");

    // 2. Real compact_delta detects file modification since before_compaction checkpoint
    mtimes = { "spec.md": 250, "new.ts": 260 };
    now += 5000;
    const delta = JSON.parse((await api.executeTool("compact_delta")).content[0].text);
    expect(delta.deltaCount).toBe(2);
    expect(delta.modified).toEqual(["spec.md"]);
    expect(delta.added).toEqual(["new.ts"]);

    // 3. Real sanitize_transcript reads and inspects transcript lines
    const san = JSON.parse(
      (await api.executeTool("sanitize_transcript", { sessionKey: "s1", dryRun: false })).content[0].text,
    );
    expect(san.ok).toBe(true);
    expect(san.linesExamined).toBe(3);

    // 4. M1 event push on after_tool_call injects into InMemoryPluginApi workflow
    await api.dispatchHook("after_tool_call", {
      toolName: "exec",
      params: { action: "format_report" },
      sessionKey: "s1",
    });
    expect(api.injections).toHaveLength(1);

    // 5. Sidecar health & exec
    const sh = JSON.parse((await api.executeTool("sidecar_health")).content[0].text);
    expect(sh.status).toBe("healthy");
    const se = JSON.parse(
      (await api.executeTool("sidecar_exec", { operation: "json.stringify", data: { ok: true } })).content[0].text,
    );
    expect(se.ok).toBe(true);

    await api.dispatchHook("gateway_stop");
  });
});
