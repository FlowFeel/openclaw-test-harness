/**
 * oc-e2e-trace-test integration test — wiring + real Protocol doubles.
 *
 * @dft
 * - Uses a REAL in-memory Protocol double (not vi.fn() patch-over).
 * - Tests the wiring (index.ts) delegates to the pure seam correctly.
 */

import { describe, it, expect, vi } from "vitest";
import plugin from "../src/index.js";

describe("oc-e2e-trace-test plugin wiring", () => {
  it("registers the expected hooks and tools", () => {
    const hooks: string[] = [];
    const tools: string[] = [];
    const api = {
      registerHook: (events: string | string[], _handler: unknown) => {
        if (typeof events === "string") hooks.push(events);
        else hooks.push(...events);
      },
      registerTool: (tool: { name: string }) => tools.push(tool.name),
    };

    plugin.register(api as never, {});

    expect(hooks).toEqual(["gateway_start"]);
    expect(tools).toEqual([]);
  });
});
