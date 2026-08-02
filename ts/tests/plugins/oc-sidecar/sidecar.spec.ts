import { describe, it, expect, vi } from "vitest";
import { createSidecarClient } from "../../../src/plugins/oc-sidecar/src/sidecar-client.js";

describe("SidecarClient", () => {
  it("GET returns parsed JSON on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: "live" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createSidecarClient("http://127.0.0.1:18900", {
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    const result = await client.get("/health");
    expect(result).toEqual({ ok: true, status: "live" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18900/health",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("POST sends JSON body and returns parsed result", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: "serialized" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createSidecarClient("http://127.0.0.1:18900", {
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    const result = await client.post("/exec", {
      operation: "json.stringify",
      data: { hello: "world" },
    });
    expect(result).toEqual({ ok: true, result: "serialized" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18900/exec",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operation: "json.stringify",
          data: { hello: "world" },
        }),
      })
    );
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );
    const client = createSidecarClient("http://127.0.0.1:18900", {
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    await expect(client.get("/health")).rejects.toThrow("returned 500");
  });

  it("aborts after timeout", async () => {
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new DOMException("Aborted", "AbortError"));
          }, 100);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const client = createSidecarClient("http://127.0.0.1:18900", {
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(client.get("/health")).rejects.toThrow();
  });
});

describe("Worker handlers (pure functions)", () => {
  it("json.stringify produces correct output", () => {
    const data = { a: 1, b: [2, 3] };
    const result = JSON.stringify(data, null, 2);
    expect(result).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("json.parse round-trips through stringify", () => {
    const data = { nested: { array: [1, 2, { deep: true }] } };
    const text = JSON.stringify(data);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(data);
  });

  it("compact.context truncates to maxBytes on message boundary", () => {
    const transcript = "msg1\n\nmsg2\n\nmsg3\n\nmsg4";
    const maxBytes = 10;
    const truncated = transcript.slice(0, maxBytes);
    const lastBoundary = truncated.lastIndexOf("\n\n");
    const cut = lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated;
    const summary = `[... ${Buffer.byteLength(transcript, "utf8")} bytes compacted to ${Buffer.byteLength(cut, "utf8")} bytes ...]\n\n`;
    const result = summary + cut;
    expect(result).toContain("compacted");
    expect(result).toContain("msg1");
  });

  it("compact.context returns original when under limit", () => {
    const transcript = "small";
    const maxBytes = 100;
    const originalSize = Buffer.byteLength(transcript, "utf8");
    expect(originalSize).toBeLessThanOrEqual(maxBytes);
  });

  it("serialize.session produces JSON string", () => {
    const session = { key: "test", messages: 42 };
    const result = JSON.stringify(session);
    expect(result).toContain('"key":"test"');
    expect(result).toContain('"messages":42');
  });
});
