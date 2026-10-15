import { describe, expect, it } from "vitest";

import {
  buildEventRequest,
  buildListRequest,
  buildResultRequest,
  buildRetryRequest,
  buildSpawnRequest,
  buildStatusRequest,
  buildTasksRequest,
  buildWaitRequest,
  interpret,
  interpretList,
  interpretResult,
  interpretTasks,
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

  it("result builders with and without pagination/limit opts", () => {
    expect(buildResultRequest("t1")).toEqual({ method: "GET", path: "/task/t1" });
    expect(buildResultRequest("t1", { maxBytes: 4000, tailLines: 50 })).toEqual({
      method: "GET", path: "/task/t1?max_bytes=4000&tail_lines=50",
    });
  });

  it("wait/retry/status/event builders", () => {
    expect(buildWaitRequest("t1", 300)).toEqual({
      method: "POST", path: "/task/t1/wait", body: { timeout_seconds: 300 },
    });
    expect(buildRetryRequest("t1")).toEqual({
      method: "POST", path: "/task/t1/retry", body: { resume: true },
    });
    expect(buildRetryRequest("t1", false)).toEqual({
      method: "POST", path: "/task/t1/retry", body: { resume: false },
    });
    expect(buildStatusRequest()).toEqual({ method: "GET", path: "/status" });
    expect(buildEventRequest("ev", { n: 1 })).toEqual({
      method: "POST", path: "/event/ev", body: { payload: { n: 1 } },
    });
  });

  it("tasks and list request builders", () => {
    expect(buildTasksRequest()).toEqual({ method: "GET", path: "/tasks" });
    expect(buildTasksRequest("agent_step")).toEqual({ method: "GET", path: "/tasks?name=agent_step" });

    expect(buildListRequest()).toEqual({ method: "GET", path: "/tasks/runs" });
    expect(buildListRequest({ task_name: "agent_step", state: "completed", limit: 20 })).toEqual({
      method: "GET", path: "/tasks/runs?task_name=agent_step&state=completed&limit=20",
    });
  });
});

describe("interpret", () => {
  it("spawn response -> ok", () => {
    const out = interpret({ status: 200, body: { task_id: "abc" } });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("abc");
  });

  it("running/waiting task -> pending verdict with optional heartbeat", () => {
    for (const state of ["pending", "running", "sleeping"]) {
      const out = interpret({ status: 200, body: { task_id: "t", state } });
      expect(out.verdict).toBe("pending");
    }

    const withProgress = interpret({
      status: 200,
      body: {
        task_id: "t",
        state: "running",
        last_progress_at: "2026-10-15T10:04:10Z",
        progress_message: "Step 4/6",
      },
    });
    expect(withProgress.summary).toContain("heartbeat: 2026-10-15T10:04:10Z - Step 4/6");
  });

  it("completed task -> ok with result tail capped at 200 for wait/status", () => {
    const out = interpret({
      status: 200, body: { task_id: "t", state: "completed", result: { ok: true } },
    });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("completed");
  });

  it("durable_result preserves full result payload without 200-char truncation and emits artifacts", () => {
    const longTail = "x".repeat(3000);
    const resultResp = {
      status: 200,
      body: {
        task_id: "01a14066",
        state: "completed",
        result: {
          exit_code: 0,
          output_tail: longTail,
          artifacts: ["/data/sessions/01a14066/ingest_verification.json"],
        },
      },
    };

    const out = interpretResult(resultResp);
    expect(out.verdict).toBe("ok");
    expect(out.summary.length).toBeGreaterThan(2000);
    expect(out.summary).toContain(longTail);
    expect(out.summary).toContain("ingest_verification.json");
    expect(out.summary).toContain("artifacts:");
  });

  it("durable_result respects custom maxBytes truncation", () => {
    const longTail = "a".repeat(500);
    const resultResp = {
      status: 200,
      body: {
        task_id: "01a14066",
        state: "completed",
        result: { output_tail: longTail },
      },
    };

    const out = interpretResult(resultResp, { maxBytes: 100 });
    expect(out.summary).toContain("[truncated at 100 bytes]");
  });

  it("interpretTasks formats registered task definitions and schemas", () => {
    const out = interpretTasks({
      status: 200,
      body: {
        tasks: [
          {
            name: "agent_step",
            description: "Run agent in isolated session",
            queue: "default",
            params_schema: { prompt: "string" },
          },
        ],
      },
    });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("tasks registered (1):");
    expect(out.summary).toContain("- agent_step [queue: default] — Run agent in isolated session");
    expect(out.summary).toContain("params: {\"prompt\":\"string\"}");
  });

  it("interpretList formats recent task runs", () => {
    const out = interpretList({
      status: 200,
      body: {
        runs: [
          {
            task_id: "t-1",
            task_name: "agent_step",
            state: "completed",
            summary: "Rebuild link history",
          },
        ],
      },
    });
    expect(out.verdict).toBe("ok");
    expect(out.summary).toContain("recent runs (1):");
    expect(out.summary).toContain("- t-1 (agent_step) [completed]: Rebuild link history");
  });

  it("failed, error, or cancelled task -> failed verdict", () => {
    for (const state of ["failed", "error", "cancelled"]) {
      const out = interpret({
        status: 200,
        body: { task_id: "t", state, result: { error: "fatal" } },
      });
      expect(out.verdict).toBe("failed");
      expect(out.summary).toContain(state);
    }
  });

  it("400 -> rejected with sidecar error and schema suggestion if present", () => {
    const simple = interpret({ status: 400, body: { error: "unknown task 'typo'" } });
    expect(simple.verdict).toBe("rejected");
    expect(simple.summary).toContain("typo");

    const rich = interpret({
      status: 400,
      body: {
        error: "Unregistered task 'rebuld'",
        allowed_tasks: ["agent_step"],
        suggestion: "Did you mean 'agent_step'?",
      },
    });
    expect(rich.verdict).toBe("rejected");
    expect(rich.summary).toBe("Unregistered task 'rebuld'. Allowed tasks: [agent_step] (Did you mean 'agent_step'?)");
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
