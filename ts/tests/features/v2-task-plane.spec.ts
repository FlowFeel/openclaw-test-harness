/**
 * Tier 3 BDD Spec: v2-task-plane.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemoryPluginApi.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-task-plane/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";
import type { TaskPlaneRegistry } from "../../src/plugins/shared/types.js";

describe("Feature: Plugins v2 Task Plane — Lock-Free Dispatch, Pipelines, Staging Verify & Durable Proxy", () => {
  it("Scenario: Lock-free task dispatch creates a tracked running task and supports cancellation", async () => {
    const api = new InMemoryPluginApi();
    let stored: TaskPlaneRegistry | null = null;
    pluginDef.register(api, {
      registryPath: "/mem/tasks.json",
      outputDir: "/mem/out",
      reader: () => stored,
      writer: (r: TaskPlaneRegistry) => {
        stored = r;
      },
      spawner: (_cmd: string, opts: { onExit: (code: number | null) => void }) => ({
        pid: 1234,
        kill: () => opts.onExit(137),
      }),
    });

    const disp = JSON.parse(
      (await api.executeTool("task_dispatch", { kind: "exec", command: "echo ok", owner: "s1" })).content[0].text,
    );
    expect(disp.status).toBe("running");

    const status = JSON.parse(
      (await api.executeTool("task_status", { taskId: disp.taskId })).content[0].text,
    );
    expect(status.task.status).toBe("running");

    const cancel = JSON.parse(
      (await api.executeTool("task_cancel", { taskId: disp.taskId, reason: "abort" })).content[0].text,
    );
    expect(cancel.status).toBe("killed");
  });

  it("Scenario: Staging verification distinguishes live deployments from stale images", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {
      fetchStagingRevision: async () => ({ ok: true, status: 200, payload: { sha: "a1b2c3d" } }),
    });

    const live = JSON.parse(
      (
        await api.executeTool("staging_verify", {
          url: "https://staging.test/version.json",
          expectedSha: "a1b2c3d",
        })
      ).content[0].text,
    );
    expect(live.verified).toBe(true);
    expect(live.status).toBe("live");

    const stale = JSON.parse(
      (
        await api.executeTool("staging_verify", {
          url: "https://staging.test/version.json",
          expectedSha: "deadbeef",
        })
      ).content[0].text,
    );
    expect(stale.verified).toBe(false);
    expect(stale.status).toBe("stale_image_running");
  });

  it("Scenario: Work queue enforces concurrency cap and tracks total queued tasks", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { maxConcurrentSubagents: 2 });

    const qw = JSON.parse(
      (
        await api.executeTool("queue_work", {
          tasks: [
            { id: "t1", prompt: "a" },
            { id: "t2", prompt: "b" },
            { id: "t3", prompt: "c" },
          ],
        })
      ).content[0].text,
    );
    expect(qw.queued).toBe(3);
    expect(qw.dispatched).toBe(2);

    const qs = JSON.parse((await api.executeTool("queue_status")).content[0].text);
    expect(qs.total).toBe(3);
  });
});

