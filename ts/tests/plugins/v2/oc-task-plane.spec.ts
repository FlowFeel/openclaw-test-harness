/**
 * Unified Engine Suite: oc-task-plane (Plugins v2) — Protocol-Double Verification.
 *
 * @dft Uses InMemoryPluginApi and stateful in-process I/O doubles (Axiom A5) — zero vi.fn() mocks.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../../src/plugins/v2/oc-task-plane/src/index.js";
import type { TaskPlaneRegistry } from "../../../src/plugins/shared/types.js";
import type { SidecarRequest, SidecarResponse } from "../../../src/plugins/v2/oc-task-plane/src/durable-sidecar-logic.js";
import type { FetchRevisionResult } from "../../../src/plugins/v2/oc-task-plane/src/staging-verify-io.js";
import { InMemoryPluginApi } from "../../doubles/in-memory-plugin-api.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Unified Engine: oc-task-plane (Plugins v2)", () => {
  it("conforms bidirectionally with openclaw.plugin.json manifest contracts", () => {
    const manifestPath = resolve(
      __dirname,
      "../../../src/plugins/v2/oc-task-plane/openclaw.plugin.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    expect(manifest.contracts.hooks.sort()).toEqual(api.registeredHookNames());
    expect(manifest.contracts.tools.sort()).toEqual(api.registeredToolNames());
  });

  it("executes task_dispatch, task_status, and task_cancel in-memory", async () => {
    const api = new InMemoryPluginApi();
    let stored: TaskPlaneRegistry | null = null;
    pluginDef.register(api, {
      registryPath: "/mem/test-tasks.json",
      outputDir: "/mem/test-output",
      reader: () => stored,
      writer: (r: TaskPlaneRegistry) => {
        stored = r;
      },
      spawner: (_cmd: string, opts: { onExit: (code: number | null) => void }) => ({
        pid: 4242,
        kill: () => opts.onExit(137),
      }),
    });

    const parsedDispatch = JSON.parse(
      (await api.executeTool("task_dispatch", { kind: "exec", command: "echo 'hello'", owner: "session-test" })).content[0].text,
    );
    expect(parsedDispatch.ok).toBe(true);
    expect(parsedDispatch.status).toBe("running");

    const parsedStatus = JSON.parse(
      (await api.executeTool("task_status", { taskId: parsedDispatch.taskId })).content[0].text,
    );
    expect(parsedStatus.ok).toBe(true);
    expect(parsedStatus.task.id).toBe(parsedDispatch.taskId);

    const parsedCancel = JSON.parse(
      (await api.executeTool("task_cancel", { taskId: parsedDispatch.taskId, reason: "Unit test termination" })).content[0].text,
    );
    expect(parsedCancel.ok).toBe(true);
    expect(parsedCancel.status).toBe("killed");
  });

  it("handles staging_verify and durable_spawn with stateful Protocol doubles", async () => {
    const seenDurable: Array<{ req: SidecarRequest; timeoutMs: number }> = [];
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {
      fetchStagingRevision: async (): Promise<FetchRevisionResult> => ({
        ok: true,
        status: 200,
        payload: { sha: "a1b2c3d4e5f6789012345678901234567890abcd" },
      }),
      fetchJson: async (req: SidecarRequest, timeoutMs: number): Promise<SidecarResponse> => {
        seenDurable.push({ req, timeoutMs });
        return { status: 200, body: { task_id: "absurd-42", state: "running" } };
      },
    });

    const parsedVerify = JSON.parse(
      (
        await api.executeTool("staging_verify", {
          url: "https://staging.test/version.json",
          expectedSha: "a1b2c3d4e5f6789012345678901234567890abcd",
        })
      ).content[0].text,
    );
    expect(parsedVerify.verified).toBe(true);
    expect(parsedVerify.status).toBe("live");

    const res = await api.executeTool("durable_spawn", {
      task_name: "test_job",
      params: { foo: "bar" },
    });
    expect(seenDurable).toHaveLength(1);
    expect(seenDurable[0].req.method).toBe("POST");
    expect(seenDurable[0].req.path).toBe("/spawn");
    expect(seenDurable[0].timeoutMs).toBe(180000);
    expect(res.content[0].text).toContain("pending: state=running");
  });
});
