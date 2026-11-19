/**
 * Unified Engine Suite: oc-memory-nexus (Plugins v2) — Protocol-Double Verification.
 *
 * @dft Uses InMemoryPluginApi and InMemorySidecarClient (Axiom A5) — zero vi.fn() mocks.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-memory-nexus/src/index.js";
import type { RawNoteFile } from "../../../src/plugins/v2/oc-memory-nexus/src/memory-recall-io.js";
import { InMemoryPluginApi } from "../../doubles/in-memory-plugin-api.js";
import { InMemorySidecarClient } from "../../doubles/in-memory-io.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Unified Engine: oc-memory-nexus (Plugins v2)", () => {
  it("conforms bidirectionally with openclaw.plugin.json manifest contracts", () => {
    const manifestPath = resolve(
      __dirname,
      "../../../src/plugins/v2/oc-memory-nexus/openclaw.plugin.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    expect(manifest.contracts.hooks.sort()).toEqual(api.registeredHookNames());
    expect(manifest.contracts.tools.sort()).toEqual(api.registeredToolNames());
  });

  it("indexes memory notes on gateway_start and reports in recall_status / catalogue", async () => {
    const mockNotes: RawNoteFile[] = [
      {
        id: "user-prefs",
        filePath: "memory/user-prefs.md",
        rawContent:
          "---\nkind: user_preference\nuse_when: formatting replies\ndoes_not_apply_when: raw json requested\n" +
          "provenance: user interview\nsource: memory/user-prefs.md\n---\nPrefers concise replies.",
      },
      {
        id: "infra-rule",
        filePath: "memory/infra-rule.md",
        rawContent:
          "---\nkind: code_rule\nuse_when: infrastructure tasks\ndoes_not_apply_when: sandbox test\n" +
          "provenance: architecture spec\nsource: memory/infra-rule.md\n---\nNo direct production access.",
      },
    ];

    const api = new InMemoryPluginApi();
    pluginDef.register(api, { notesLoader: () => mockNotes });

    await api.dispatchHook("gateway_start");

    const parsedStatus = JSON.parse((await api.executeTool("recall_status")).content[0].text);
    expect(parsedStatus.detail.totalNotes).toBe(2);
    expect(parsedStatus.detail.validCount).toBe(2);

    const parsedCat = JSON.parse(
      (await api.executeTool("recall_catalogue", { kind: "user_preference" })).content[0].text,
    );
    expect(parsedCat.totalListed).toBe(1);
    expect(parsedCat.catalogue).toContain("user-prefs");
  });

  it("handles sidecar_health and sidecar_exec with InMemorySidecarClient", async () => {
    const sidecar = new InMemorySidecarClient();
    sidecar.setGetResponse("/health", { status: "healthy", poolSize: 3, active: 0 });
    sidecar.setPostResponse("/exec/json.stringify", { json: "ok" });

    const api = new InMemoryPluginApi();
    pluginDef.register(api, { sidecarClient: sidecar });

    const hParsed = JSON.parse((await api.executeTool("sidecar_health")).content[0].text);
    expect(hParsed.status).toBe("healthy");

    const eParsed = JSON.parse(
      (await api.executeTool("sidecar_exec", { operation: "json.stringify", data: { a: 1 } })).content[0].text,
    );
    expect(eParsed.ok).toBe(true);
    expect(eParsed.result.json).toBe("ok");
  });
});
