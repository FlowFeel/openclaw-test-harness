/** Pure logic spec — inline data, zero fixtures (DFT). */
import { describe, expect, it } from "vitest";

import {
  buildEventRequest,
  buildResultRequest,
  buildRetryRequest,
  buildSpawnRequest,
  buildStatusRequest,
  buildWaitRequest,
  interpret,
  interpretTransportFailure,
} from "../src/durable-sidecar-logic.js";

describe("request builders", () => {
  it("spawn includes task_name, params and optional queue", () => {
    const r = buildSpawnRequest("agent_step", { prompt: "p" }, "default");
    expect(r).toEqual({
      method: "POST", path: "/spawn",
      body: { task_name: "agent_step", params: { prompt: "p" }, queue: "default" },
    });
  });

  it("spawn omits queue when not given", () => {
    const r = buildSpawnRequest("agent_step", {});
    expect(r.body).toEqual({ task_name: "agent_step", params: {} });
  });

  it("result/wait/retry/status/event builders", () => {
    expect(buildResultRequest("t1")).toEqual({ method: "GET", path: "/task/t1" });
    expect(buildWaitRequest("t1", 300)).toEqual({
      method: "POST", path: "/task/t1/wait", body: { timeout_seconds: 300 },
    });
    expect(buildRetryRequest("t1")).toEqual({ method: "POST", path: "/task/t1/retry" });
    expect(buildStatusRequest()).toEqual({ method: "GET", path: "/status" });
    expect(buildEventRequest("ev", { n: 1 })).toEqual({
      method: "POST", path: "/event/ev", body: { payload: { n: 1 } },
    });
  });
});

describe("interpret", () => {
  it("spawn response -> ok", () => {
    const out = interpret({ status: 200, body: { task_id: "abc" } });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("abc");
  });

  it("running/waiting task -> pending verdict", () => {
    for (const state of ["pending", "running", "sleeping"]) {
      const out = interpret({ status: 200, body: { task_id: "t", state } });
      expect(out.verdict).toBe("pending");
    }
  });

  it("completed task -> ok with result tail", () => {
    const out = interpret({
      status: 200, body: { task_id: "t", state: "completed", result: { ok: true } },
    });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("completed");
  });

  it("400 -> rejected with sidecar error", () => {
    const out = interpret({ status: 400, body: { error: "unknown task 'typo'" } });
    expect(out.verdict).toBe("rejected");
    expect(out.summary).toContain("typo");
  });

  it("404 -> failed", () => {
    expect(interpret({ status: 404, body: { error: "unknown task x" } }).verdict).toBe("failed");
  });

  it("transport failure -> sidecar-down with unit pointer implied", () => {
    const out = interpretTransportFailure(new Error("ECONNREFUSED"));
    expect(out.verdict).toBe("sidecar-down");
    expect(out.summary).toContain("ECONNREFUSED");
  });
});
