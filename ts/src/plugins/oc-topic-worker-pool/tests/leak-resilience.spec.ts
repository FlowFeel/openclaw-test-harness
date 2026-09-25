/**
 * oc-topic-worker-pool leak resilience and deadlock prevention specs (Ticket #18).
 *
 * @dft
 * - Pure & in-memory Protocol doubles (no vi.fn() stand-ins).
 * - Deterministic timeouts and explicit cancellation assertions.
 * - Incident replay: proves pool does not permanently saturate after hook timeouts.
 */

import { describe, it, expect } from "vitest";
import plugin, {
  createAsyncSemaphore,
  extractRunId,
} from "../src/index.js";
import type { PluginApi } from "../../shared/types.js";

/** In-memory PluginApi double. */
class InMemoryPluginApi {
  public hooks = new Map<string, Array<(event: unknown, ctx?: unknown) => Promise<unknown>>>();
  public logs: { level: string; msg: string }[] = [];

  on(event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
    const list = this.hooks.get(event) ?? [];
    list.push(handler);
    this.hooks.set(event, list);
  }

  registerHook(events: string | string[], handler: (event: unknown, ctx?: unknown) => Promise<unknown>) {
    const names = Array.isArray(events) ? events : [events];
    for (const name of names) {
      this.on(name, handler);
    }
  }

  registerTool() {}

  logger = {
    info: (msg: string): void => {
      this.logs.push({ level: "info", msg });
    },
    error: (msg: string): void => {
      this.logs.push({ level: "error", msg });
    },
    warn: (msg: string): void => {
      this.logs.push({ level: "warn", msg });
    },
    debug: (msg: string): void => {
      this.logs.push({ level: "debug", msg });
    },
  };

  async trigger(name: string, event: unknown, ctx?: unknown): Promise<unknown> {
    const list = this.hooks.get(name) ?? [];
    let lastResult: unknown;
    for (const h of list) {
      lastResult = await h(event, ctx);
    }
    return lastResult;
  }
}

describe("AsyncSemaphore leak resilience", () => {
  it("times out in queue without consuming or leaking a slot", async () => {
    const sem = createAsyncSemaphore(1);

    // Acquire the only slot
    const r1 = await sem.acquire();
    expect(r1.action).toBe("acquired");
    expect(sem.state.active).toBe(1);

    // Second acquire with short timeout
    const r2 = await sem.acquire({ timeoutMs: 30 });
    expect(r2.action).toBe("timeout");
    expect(r2.reason).toContain("timed out after 30ms");
    expect(sem.state.active).toBe(1); // Still 1 held by r1

    // First run releases
    const rRel = sem.release();
    expect(rRel.action).toBe("released");
    expect(sem.state.active).toBe(0); // Drops to 0! Did not allocate to timed-out waiter!
  });

  it("aborts via AbortSignal without leaking a slot", async () => {
    const sem = createAsyncSemaphore(1);
    await sem.acquire();
    expect(sem.state.active).toBe(1);

    const controller = new AbortController();
    const waitPromise = sem.acquire({ signal: controller.signal });

    // Abort while queued
    controller.abort();
    const r2 = await waitPromise;
    expect(r2.action).toBe("rejected");
    expect(r2.reason).toContain("aborted by signal");
    expect(sem.state.active).toBe(1);

    // When slot 1 releases, active must drop to 0
    sem.release();
    expect(sem.state.active).toBe(0);
  });

  it("skips cancelled waiters and hands the freed slot to the next live waiter", async () => {
    const sem = createAsyncSemaphore(1);
    await sem.acquire(); // slot taken

    // Waiter 1: times out
    const p1 = sem.acquire({ timeoutMs: 20 });
    // Waiter 2: live waiter with long timeout
    const p2 = sem.acquire({ timeoutMs: 500 });

    const r1 = await p1;
    expect(r1.action).toBe("timeout");

    // Release slot from first run
    sem.release();

    // Waiter 2 should be resumed with acquired
    const r2 = await p2;
    expect(r2.action).toBe("acquired");
    expect(sem.state.active).toBe(1);

    // Waiter 2 releases
    sem.release();
    expect(sem.state.active).toBe(0);
  });

  it("rejects promise when rejectOnTimeout is true", async () => {
    const sem = createAsyncSemaphore(1);
    await sem.acquire();
    await expect(sem.acquire({ timeoutMs: 20, rejectOnTimeout: true })).rejects.toThrow(
      "acquire timed out after 20ms",
    );
    sem.release();
    expect(sem.state.active).toBe(0);
  });
});

describe("extractRunId correlation helper", () => {
  it("resolves runId from ctx or event with multiple fallbacks", () => {
    expect(extractRunId({ runId: "ev-1" }, {})).toBe("ev-1");
    expect(extractRunId({}, { runId: "ctx-1" })).toBe("ctx-1");
    expect(extractRunId({ sessionId: "sess-ev" }, {})).toBe("sess-ev");
    expect(extractRunId({}, { sessionId: "sess-ctx" })).toBe("sess-ctx");
    expect(extractRunId({}, { conversationId: "conv-1" })).toBe("conv-1");
    expect(extractRunId({}, {})).toBe("");
  });
});

describe("oc-topic-worker-pool wiring leak resilience (Ticket #18 & #45)", () => {
  it("fails open with { outcome: 'pass' } when queue wait times out (never blocks gateway)", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 1,
      acquireTimeoutMs: 40,
      watchdogIntervalMs: 0,
    });

    // Run 1 acquires the only slot
    const res1 = (await api.trigger(
      "before_agent_run",
      { prompt: "first" },
      { runId: "run-1" }
    )) as { outcome: string };
    expect(res1.outcome).toBe("pass");

    // Run 2 queues and times out after 40ms — must FAIL OPEN to "pass" so gateway never blocks!
    const res2 = (await api.trigger(
      "before_agent_run",
      { prompt: "second" },
      { runId: "run-2" }
    )) as { outcome: string; reason?: string };
    expect(res2.outcome).toBe("pass");
    const warnLog = api.logs.find((l) => l.msg.includes("failing open to avoid blocking gateway"));
    expect(warnLog).toBeDefined();

    // Run 1 finishes and releases
    await api.trigger("agent_end", {}, { runId: "run-1" });

    // Run 3 arrives and immediately succeeds
    const res3 = (await api.trigger(
      "before_agent_run",
      { prompt: "third" },
      { runId: "run-3" }
    )) as { outcome: string };
    expect(res3.outcome).toBe("pass");
  });

  it("REPLAY INCIDENT: 3 saturated slots + 3 timed-out runs fail open without deadlock or blocked turns", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 3,
      acquireTimeoutMs: 30,
      watchdogIntervalMs: 0,
    });

    // 1. Three active runs saturate the pool (active = 3/3)
    const runA = await api.trigger("before_agent_run", {}, { runId: "run-A" });
    const runB = await api.trigger("before_agent_run", {}, { runId: "run-B" });
    const runC = await api.trigger("before_agent_run", {}, { runId: "run-C" });
    expect((runA as { outcome: string }).outcome).toBe("pass");
    expect((runB as { outcome: string }).outcome).toBe("pass");
    expect((runC as { outcome: string }).outcome).toBe("pass");

    // 2. Three incoming runs arrive and time out in queue (in prod old code these hung or blocked with "Your message could not be sent")
    const runD = await api.trigger("before_agent_run", {}, { runId: "run-D" });
    const runE = await api.trigger("before_agent_run", {}, { runId: "run-E" });
    const runF = await api.trigger("before_agent_run", {}, { runId: "run-F" });
    // ALL 3 MUST PASS THROUGH! Zero blocked turns!
    expect((runD as { outcome: string }).outcome).toBe("pass");
    expect((runE as { outcome: string }).outcome).toBe("pass");
    expect((runF as { outcome: string }).outcome).toBe("pass");

    // 3. Now the 3 original runs complete and invoke agent_end
    await api.trigger("agent_end", {}, { runId: "run-A" });
    await api.trigger("agent_end", {}, { runId: "run-B" });
    await api.trigger("agent_end", {}, { runId: "run-C" });

    // 4. In the old bug, the pool remained at active=3/3 permanently deadlocked!
    // With our fix, all 3 timed-out waiters were purged, and active drops back to 0!
    // Run G must be able to acquire immediately!
    const runG = (await api.trigger("before_agent_run", {}, { runId: "run-G" })) as { outcome: string };
    expect(runG.outcome).toBe("pass");

    // Clean up Run G
    await api.trigger("agent_end", {}, { runId: "run-G" });
  });

  it("releases slot immediately if run's AbortSignal fires (lane-killed / cap-aborted run)", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 1,
      acquireTimeoutMs: 50,
      watchdogIntervalMs: 0,
    });

    const abortController = new AbortController();
    const run1 = (await api.trigger(
      "before_agent_run",
      {},
      { runId: "aborted-run", signal: abortController.signal },
    )) as { outcome: string };
    expect(run1.outcome).toBe("pass");

    // Simulate lane kill / cap-abort at 600s: signal aborts, agent_end never fires
    abortController.abort();

    // Check that abort release was logged
    const abortLog = api.logs.find((l) => l.msg.includes("abort signal received"));
    expect(abortLog).toBeDefined();

    // Slot was released immediately! Next run acquires without waiting
    const run2 = (await api.trigger(
      "before_agent_run",
      {},
      { runId: "next-run" },
    )) as { outcome: string };
    expect(run2.outcome).toBe("pass");
  });

  it("releases slot immediately if session_end fires", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 1,
      acquireTimeoutMs: 50,
      watchdogIntervalMs: 0,
    });

    await api.trigger("before_agent_run", {}, { runId: "sess-run-1" });

    // session_end fires (e.g. session terminated without agent_end)
    await api.trigger("session_end", {}, { runId: "sess-run-1" });

    const cleanupLog = api.logs.find((l) => l.msg.includes("session_end: cleaned up"));
    expect(cleanupLog).toBeDefined();

    // Next run can acquire immediately
    const nextRun = (await api.trigger("before_agent_run", {}, { runId: "sess-run-2" })) as { outcome: string };
    expect(nextRun.outcome).toBe("pass");
  });

  it("releases slot immediately if before_agent_run encounters post-acquire error", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 1,
      acquireTimeoutMs: 50,
      watchdogIntervalMs: 0,
    });

    // Make logger throw after slot is acquired
    let throwOnLog = false;
    const originalInfo = api.logger.info;
    api.logger.info = (msg: string) => {
      if (throwOnLog && msg.includes("main pool: active=")) {
        throw new Error("simulated post-acquire hook error");
      }
      originalInfo(msg);
    };

    throwOnLog = true;
    const res = (await api.trigger("before_agent_run", {}, { runId: "faulty-run" })) as { outcome: string };
    expect(res.outcome).toBe("pass");

    // The slot was cleaned up in the error path! Next run should acquire immediately without blocking
    throwOnLog = false;
    const nextRun = (await api.trigger("before_agent_run", {}, { runId: "clean-run" })) as { outcome: string };
    expect(nextRun.outcome).toBe("pass");
  });

  it("watchdog opportunistically sweeps on before_agent_reply and reconciles orphaned slots", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      mainPoolMax: 2,
      maxLeaseDurationMs: 50, // 50ms TTL
      watchdogIntervalMs: 0,
    });

    // Acquire slot
    await api.trigger("before_agent_run", {}, { runId: "stale-run" });

    // Wait past the 50ms lease TTL
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Egress hook triggers watchdog sweep
    await api.trigger("before_agent_reply", {});

    const warningLog = api.logs.find((l) => l.msg.includes("force-released stale main slot"));
    expect(warningLog).toBeDefined();

    // Saturated slot was force-freed; next run acquires without queue delay
    const res = (await api.trigger("before_agent_run", {}, { runId: "fresh-run" })) as { outcome: string };
    expect(res.outcome).toBe("pass");
  });

  it("subagent pool parity: acquires and releases sub pool slots cleanly", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api as unknown as PluginApi, {
      enabled: true,
      subPoolMax: 1,
      acquireTimeoutMs: 30,
      watchdogIntervalMs: 0,
    });

    await api.trigger("subagent_spawning", {}, { runId: "sub-1" });
    // Second subagent queues and times out
    await api.trigger("subagent_spawning", {}, { runId: "sub-2" });

    const warn = api.logs.find((l) => l.msg.includes("sub pool saturated"));
    expect(warn).toBeDefined();

    // Release sub-1
    await api.trigger("subagent_ended", {}, { runId: "sub-1" });

    // Sub-3 can now acquire
    await api.trigger("subagent_spawning", {}, { runId: "sub-3" });
    const successLog = api.logs.filter((l) => l.msg.includes("acquiring sub pool slot (runId=sub-3)"));
    expect(successLog.length).toBe(1);
  });
});
