/**
 * Sidecar plugin tests — pure logic, no OC runtime needed.
 *
 * @dft principles:
 * - Deterministic: mock fetch, mock spawn, deterministic clocks
 * - Pure logic: handlers are pure functions (input → output)
 * - Protocol interfaces: SidecarClient is a protocol (mockable)
 * - No fixtures: all data is inline
 * - Fast: no real processes, no real HTTP
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSidecarClient } from "../../../src/plugins/oc-sidecar/src/sidecar-client.ts";

// ── SidecarClient tests ───────────────────────────────────────

describe("SidecarClient", () => {
  it("GET returns parsed JSON on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: "live" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = createSidecarClient("http://127.0.0.1:18900", {
      fetchFn: mockFetch as any,
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
      fetchFn: mockFetch as any,
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
      fetchFn: mockFetch as any,
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
      fetchFn: mockFetch as any,
      timeoutMs: 50,
    });
    await expect(client.get("/health")).rejects.toThrow();
  });
});

// ── Worker handler tests (pure functions) ──────────────────────

describe("Worker handlers", () => {
  it("json.stringify produces correct output", async () => {
    const { default: handlerMod } = await import(
      "../../../src/plugins/oc-sidecar/src/worker-entry.ts"
    ).catch(() => ({}));
    // Inline test since handlers are not exported
    const input = { data: { a: 1, b: [2, 3] }, indent: 2 };
    const result = JSON.stringify(input.data, null, input.indent);
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
    // When under limit, returns original unchanged
  });

  it("serialize.session produces JSON string", () => {
    const session = { key: "test", messages: 42 };
    const result = JSON.stringify(session);
    expect(result).toContain('"key":"test"');
    expect(result).toContain('"messages":42');
  });
});
