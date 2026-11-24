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

  it("Scenario: Open-world payloads survive dispatch, status query, and lock-free wake delivery untouched", async () => {
    const api = new InMemoryPluginApi();
    let stored: TaskPlaneRegistry | null = null;
    let triggerExit: ((code: number | null) => void) | undefined;

    pluginDef.register(api, {
      registryPath: "/mem/bdd-owa.json",
      outputDir: "/mem/bdd-out",
      reader: () => stored,
      writer: (r: TaskPlaneRegistry) => {
        stored = r;
      },
      spawner: (_cmd: string, opts: { onExit: (code: number | null) => void }) => {
        triggerExit = opts.onExit;
        return { pid: 5678, kill: () => {} };
      },
    });

    const owner = "agent:main:telegram:group:-1003842172831:topic:83272";
    const owaPayload = { lineage: { parent: "p-1", step: 4 }, heterogeneous: [1, "x", null, true] };
    const disp = JSON.parse(
      (await api.executeTool("task_dispatch", { kind: "exec", command: "echo run", owner, payload: owaPayload }))
        .content[0].text,
    );
    const arrDisp = JSON.parse(
      (await api.executeTool("task_dispatch", { kind: "durable", owner, payload: ["unstructured", 99] }))
        .content[0].text,
    );

    const status = JSON.parse((await api.executeTool("task_status", { taskId: disp.taskId })).content[0].text);
    expect(status.task.payload).toMatchObject(owaPayload);

    const arrStatus = JSON.parse((await api.executeTool("task_status", { taskId: arrDisp.taskId })).content[0].text);
    expect(arrStatus.task.payload).toEqual({ raw: ["unstructured", 99] });

    triggerExit!(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.injections).toHaveLength(1);
    expect(api.injections[0].sessionKey).toBe(owner);
  });
});

