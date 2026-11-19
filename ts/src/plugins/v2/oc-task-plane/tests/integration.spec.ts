/**
 * Tier 2 Integration Spec: oc-task-plane (Stateful Protocol Doubles, Axiom A5).
 *
 * @dft Zero vi.fn() shims — uses InMemoryPluginApi and stateful in-process I/O doubles.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../src/index.js";
import { InMemoryPluginApi } from "../../../../../tests/doubles/in-memory-plugin-api.js";
import type { TaskPlaneRegistry } from "../../../shared/types.js";
import type { FetchRevisionResult } from "../src/staging-verify-io.js";
import type { SidecarRequest, SidecarResponse } from "../src/durable-sidecar-logic.js";

describe("oc-task-plane (Tier 2 Integration)", () => {
  it("executes task dispatch/status/cancel, staging_verify, work queue, and durable proxy with Protocol doubles", async () => {
    const api = new InMemoryPluginApi();
    let storedRegistry: TaskPlaneRegistry | null = null;
    const durableCalls: SidecarRequest[] = [];

    pluginDef.register(api, {
      registryPath: "/mem/tasks.json",
      outputDir: "/mem/out",
      reader: () => storedRegistry,
      writer: (reg: TaskPlaneRegistry) => {
        storedRegistry = reg;
      },
      spawner: (_cmd: string, opts: { onExit: (code: number | null) => void }) => {
        return { pid: 9999, kill: () => opts.onExit(137) };
      },
      fetchStagingRevision: async (): Promise<FetchRevisionResult> => ({
        ok: true,
        status: 200,
        payload: { sha: "a1b2c3d4e5f6789012345678901234567890abcd" },
      }),
      fetchJson: async (req: SidecarRequest): Promise<SidecarResponse> => {
        durableCalls.push(req);
        return { status: 200, body: { task_id: "absurd-42", state: "running" } };
      },
    });

    const disp = JSON.parse(
      (await api.executeTool("task_dispatch", { kind: "exec", command: "echo hi", owner: "s1" })).content[0].text,
    );
    expect(disp.ok).toBe(true);
    expect(disp.status).toBe("running");

    const cancel = JSON.parse(
      (await api.executeTool("task_cancel", { taskId: disp.taskId, reason: "test" })).content[0].text,
    );
    expect(cancel.ok).toBe(true);
    expect(cancel.status).toBe("killed");

    const verify = JSON.parse(
      (
        await api.executeTool("staging_verify", {
          url: "https://staging.test/version.json",
          expectedSha: "a1b2c3d4e5f6789012345678901234567890abcd",
        })
      ).content[0].text,
    );
    expect(verify.verified).toBe(true);

    const dur = await api.executeTool("durable_spawn", { task_name: "job_a", params: { x: 1 } });
    expect(dur.content[0].text).toContain("pending");
    expect(durableCalls).toHaveLength(1);

    const qw = JSON.parse(
      (await api.executeTool("queue_work", { tasks: [{ id: "w1", prompt: "search" }] })).content[0].text,
    );
    expect(qw.queued).toBe(1);
    expect(qw.dispatched).toBe(1);
  });
});
