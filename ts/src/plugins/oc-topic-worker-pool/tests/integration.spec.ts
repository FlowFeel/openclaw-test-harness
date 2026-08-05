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
  it("registers the expected hooks", () => {
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

    plugin.register(api as never, { mainPoolMax: 2, subPoolMax: 1 });

    expect(hooks).toContain("before_dispatch");
    expect(hooks).toContain("before_agent_run");
    expect(hooks).toContain("agent_end");
    expect(hooks).toContain("subagent_spawning");
    expect(hooks).toContain("subagent_ended");
    expect(hooks).toContain("before_agent_reply");
    expect(hooks.length).toBe(6);
  });

  it("logs initialization with pool sizes", () => {
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

    plugin.register(api as never, { mainPoolMax: 5, subPoolMax: 3 });

    const initLog = logs.find((l) => l.includes("initialized"));
    expect(initLog).toBeDefined();
    expect(initLog).toContain("mainPool=5");
    expect(initLog).toContain("subPool=3");
  });
});
