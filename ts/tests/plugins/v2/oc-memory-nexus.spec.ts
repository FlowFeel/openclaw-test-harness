import { describe, it, expect, vi } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-memory-nexus/src/index.js";
import type { PluginApi, ToolDefinition } from "../../../src/plugins/shared/types.js";
import type { RawNoteFile } from "../../../src/plugins/v2/oc-memory-nexus/src/memory-recall-io.js";

describe("Unified Engine: oc-memory-nexus (Plugins v2)", () => {
  function createTestApi() {
    const tools = new Map<string, ToolDefinition>();
    const hooks = new Map<string, Array<(event: any, ctx?: any) => Promise<unknown>>>();

    const api: PluginApi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      on(hookName: string, handler: (event: any, ctx?: any) => unknown) {
        if (!hooks.has(hookName)) hooks.set(hookName, []);
        hooks.get(hookName)!.push(handler as any);
      },
      registerHook: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    return { api, tools, hooks };
  }

  it("registers all 8 consolidated tools and lifecycle hooks", () => {
    const { api, tools, hooks } = createTestApi();
    pluginDef.register(api, {});

    const expectedTools = [
      "compact_check",
      "compact_delta",
      "sanitize_transcript",
      "sidecar_health",
      "sidecar_exec",
      "recall_status",
      "recall_verify",
      "recall_catalogue",
    ];

    for (const toolName of expectedTools) {
      expect(tools.has(toolName), `Missing tool ${toolName}`).toBe(true);
    }

    expect(hooks.has("gateway_start")).toBe(true);
  });

  it("indexes memory notes on gateway_start and reports in recall_status / catalogue", async () => {
    const mockNotes: RawNoteFile[] = [
      {
        id: "user-prefs",
        filePath: "memory/user-prefs.md",
        rawContent:
          "---\n" +
          "kind: user_preference\n" +
          "use_when: formatting replies\n" +
          "does_not_apply_when: raw json requested\n" +
          "provenance: user interview\n" +
          "source: memory/user-prefs.md\n" +
          "---\n" +
          "Prefers concise replies.",
      },
      {
        id: "infra-rule",
        filePath: "memory/infra-rule.md",
        rawContent:
          "---\n" +
          "kind: code_rule\n" +
          "use_when: infrastructure tasks\n" +
          "does_not_apply_when: sandbox test\n" +
          "provenance: architecture spec\n" +
          "source: memory/infra-rule.md\n" +
          "---\n" +
          "No direct production access.",
      },
    ];

    const mockLoader = vi.fn().mockReturnValue(mockNotes);
    const { api, tools, hooks } = createTestApi();

    pluginDef.register(api, {
      notesLoader: mockLoader,
    });

    const startHooks = hooks.get("gateway_start")!;
    for (const hook of startHooks) {
      await hook({});
    }

    const statusTool = tools.get("recall_status")!;
    const statusRes = await statusTool.execute("c1", {});
    const parsedStatus = JSON.parse(statusRes.content[0].text);

    expect(parsedStatus.detail.totalNotes).toBe(2);
    expect(parsedStatus.detail.validCount).toBe(2);

    const catTool = tools.get("recall_catalogue")!;
    const catRes = await catTool.execute("c2", { kind: "user_preference" });
    const parsedCat = JSON.parse(catRes.content[0].text);
    expect(parsedCat.totalListed).toBe(1);
    expect(parsedCat.catalogue).toContain("user-prefs");
  });

  it("handles sidecar_health and sidecar_exec with injected client", async () => {
    const mockSidecarClient: any = {
      get: vi.fn().mockResolvedValue({ status: "healthy", poolSize: 3, active: 0 }),
      post: vi.fn().mockResolvedValue({ json: "ok" }),
    };

    const { api, tools } = createTestApi();
    pluginDef.register(api, {
      sidecarClient: mockSidecarClient,
    });

    const healthTool = tools.get("sidecar_health")!;
    const hRes = await healthTool.execute("c3", {});
    const hParsed = JSON.parse(hRes.content[0].text);
    expect(hParsed.status).toBe("healthy");

    const execTool = tools.get("sidecar_exec")!;
    const eRes = await execTool.execute("c4", { operation: "json.stringify", data: { a: 1 } });
    const eParsed = JSON.parse(eRes.content[0].text);
    expect(eParsed.ok).toBe(true);
    expect(eParsed.result.json).toBe("ok");
  });
});
