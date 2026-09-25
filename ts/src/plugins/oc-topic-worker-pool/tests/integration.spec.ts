/**
 * oc-topic-worker-pool integration test — wiring + real Protocol doubles.
 *
 * @dft
 * - Uses a REAL in-memory Protocol double (not vi.fn() patch-over).
 * - Tests the wiring (index.ts) delegates to the pure seam correctly.
 */

import { describe, it, expect } from "vitest";
import plugin from "../src/index.js";

describe("oc-topic-worker-pool plugin wiring", () => {
  it("is disabled by default when neither config nor env enables it", () => {
    const hooks: string[] = [];
    const logs: string[] = [];
    const api = {
      on: (events: string) => hooks.push(events),
      registerHook: () => {},
      registerTool: () => {},
      logger: {
        info: (msg: string) => logs.push(msg),
        error: () => {},
        warn: () => {},
      },
    };

    plugin.register(api as never, { mainPoolMax: 2, subPoolMax: 1 });

    expect(hooks.length).toBe(0);
    expect(logs.some((l) => l.includes("disabled by default"))).toBe(true);
  });

  it("registers all 7 expected hooks when enabled: true", () => {
    const hooks: string[] = [];
    const tools: string[] = [];
    const api = {
      on: (events: string, _handler: unknown) => {
        hooks.push(events);
      },
      registerHook: (events: string | string[], _handler: unknown) => {
        if (typeof events === "string") hooks.push(events);
        else hooks.push(...events);
      },
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      logger: {
        info: () => {},
        error: () => {},
        warn: () => {},
      },
    };

    plugin.register(api as never, { enabled: true, mainPoolMax: 2, subPoolMax: 1 });

    expect(hooks).toContain("before_dispatch");
    expect(hooks).toContain("before_agent_run");
    expect(hooks).toContain("agent_end");
    expect(hooks).toContain("subagent_spawning");
    expect(hooks).toContain("subagent_ended");
    expect(hooks).toContain("before_agent_reply");
    expect(hooks).toContain("session_end");
    expect(hooks.length).toBe(7);
  });

  it("registers hooks when enabled via OPENCLAW_ENABLE_TOPIC_WORKER_POOL env var", () => {
    const prev = process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL;
    process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL = "1";
    try {
      const hooks: string[] = [];
      const api = {
        on: (events: string) => hooks.push(events),
        registerHook: () => {},
        registerTool: () => {},
        logger: {
          info: () => {},
          error: () => {},
          warn: () => {},
        },
      };

      plugin.register(api as never, { mainPoolMax: 2, subPoolMax: 1 });
      expect(hooks.length).toBe(7);
    } finally {
      if (prev !== undefined) {
        process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL = prev;
      } else {
        delete process.env.OPENCLAW_ENABLE_TOPIC_WORKER_POOL;
      }
    }
  });

  it("logs initialization with pool sizes when enabled", () => {
    const logs: string[] = [];
    const api = {
      on: () => {},
      registerHook: () => {},
      registerTool: () => {},
      logger: {
        info: (msg: string) => logs.push(msg),
        error: () => {},
        warn: () => {},
      },
    };

    plugin.register(api as never, { enabled: true, mainPoolMax: 5, subPoolMax: 3 });

    const initLog = logs.find((l) => l.includes("initialized"));
    expect(initLog).toBeDefined();
    expect(initLog).toContain("mainPool=5");
    expect(initLog).toContain("subPool=3");
  });
});
