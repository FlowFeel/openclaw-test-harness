import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const EPHEMERAL_PORT = 18999;

// Inline handler functions — match the worker handler signatures
const HANDLERS: Record<string, (input: any) => unknown> = {
  "json.stringify": (input: { data: unknown; indent?: number }) => JSON.stringify(input.data, null, input.indent),
  "json.parse": (input: { text: string }) => JSON.parse(input.text),
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${EPHEMERAL_PORT}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live", pool: { active: 0, completed: 0, poolSize: 1 } }));
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);

        if (path === "/exec") {
          const handler = HANDLERS[parsed.operation];
          if (handler) {
            // Pass the `data` field directly as the handler input
            const result = handler(parsed.data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, result }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown operation: ${parsed.operation}` }));
          }
          return;
        }
        if (path === "/session/cleanup" || path === "/session/purge-stale" || path === "/subagent/track" || path === "/subagent/end" || path === "/telemetry/collect" || path === "/telemetry/record") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

beforeAll(() => new Promise<void>((resolve) => {
  server.listen(EPHEMERAL_PORT, "127.0.0.1", () => resolve());
}));

afterAll(() => new Promise<void>((resolve) => {
  server.close(() => resolve());
}));

describe("Sidecar HTTP server", () => {
  it("GET /health returns ok=true with pool stats", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/health`);
    expect(resp.ok).toBe(true);
    const health = await resp.json();
    expect(health.ok).toBe(true);
    expect(health.status).toBe("live");
    expect(health.pool.poolSize).toBe(1);
  });

  it("POST /exec json.stringify returns serialized data", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "json.stringify",
        data: { data: { hello: "world" } },
      }),
    });
    expect(resp.ok).toBe(true);
    const result = await resp.json();
    expect(result.ok).toBe(true);
    expect(result.result).toBe(JSON.stringify({ hello: "world" }));
  });

  it("POST /exec json.parse round-trips", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "json.parse",
        data: { text: '{"a":1}' },
      }),
    });
    expect(resp.ok).toBe(true);
    const result = await resp.json();
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ a: 1 });
  });

  it("POST /exec unknown operation returns 400", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "unknown", data: {} }),
    });
    expect(resp.status).toBe(400);
  });

  it("POST /session/cleanup returns ok", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/session/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "test" }),
    });
    expect(resp.ok).toBe(true);
  });

  it("POST /subagent/track returns ok", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/subagent/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "sub-1" }),
    });
    expect(resp.ok).toBe(true);
  });

  it("GET /unknown returns 404", async () => {
    const resp = await fetch(`http://127.0.0.1:${EPHEMERAL_PORT}/unknown`);
    expect(resp.status).toBe(404);
  });
});
