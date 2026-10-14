/** Integration spec — wiring through an injected fetch double. */
import { describe, expect, it, vi } from "vitest";

import {
  buildSpawnRequest,
  interpretTransportFailure,
} from "../src/durable-sidecar-logic.js";
import { makeHttpFetchJson } from "../src/durable-sidecar-io.js";

describe("http fetch wrapper", () => {
  it("posts JSON bodies and parses JSON responses", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchDouble = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ task_id: "t-9" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchDouble);

    const fetchJson = makeHttpFetchJson("http://127.0.0.1:18950");
    const res = await fetchJson(buildSpawnRequest("agent_step", { a: 1 }, "default"), 5_000);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ task_id: "t-9" });
    expect(seen[0].url).toBe("http://127.0.0.1:18950/spawn");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      task_name: "agent_step", params: { a: 1 }, queue: "default",
    });
  });

  it("aborts on timeout; transport failure classifies as sidecar-down", async () => {
    const fetchDouble = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      });
    });
    vi.stubGlobal("fetch", fetchDouble);

    const fetchJson = makeHttpFetchJson("http://127.0.0.1:18950");
    await expect(
      fetchJson({ method: "GET", path: "/status" }, 50),
    ).rejects.toThrow(/aborted/);

    // callers catch the transport failure and classify it (pure seam)
    let verdict: string;
    try {
      await fetchJson({ method: "GET", path: "/status" }, 50);
      verdict = "no-timeout";
    } catch (err) {
      verdict = interpretTransportFailure(err).verdict;
    }
    expect(verdict).toBe("sidecar-down");
    expect(fetchDouble).toHaveBeenCalled();
  });
});
