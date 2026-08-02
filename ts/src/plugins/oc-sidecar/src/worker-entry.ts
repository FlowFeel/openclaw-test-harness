/**
 * Worker entry — runs in a worker_thread.
 *
 * @behavior
 * Receives { id, handler, input } messages from the main thread,
 * dispatches to the appropriate handler function, and posts back
 * { id, ok, result } or { id, ok:false, error }.
 *
 * @invariants
 * - Worker is stateless between tasks (no shared state).
 * - Handler crashes are caught and returned as errors.
 * - Unknown handlers return an error (fail closed).
 */

import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("Worker entry must be run as a worker_thread");
}

const port = parentPort;

// ── Built-in handlers ──────────────────────────────────────────

function jsonStringify(input: { data: unknown; indent?: number }): string {
  return JSON.stringify(input.data, null, input.indent);
}

function jsonParse(input: { text: string }): unknown {
  return JSON.parse(input.text);
}

function serializeSession(input: { session: Record<string, unknown> }): string {
  return JSON.stringify(input.session);
}

function compactContext(input: {
  transcript: string;
  maxBytes: number;
}): { compacted: string; originalSize: number; compactedSize: number } {
  const original = input.transcript;
  const originalSize = Buffer.byteLength(original, "utf8");
  if (originalSize <= input.maxBytes) {
    return { compacted: original, originalSize, compactedSize: originalSize };
  }
  const truncated = original.slice(0, input.maxBytes);
  const lastBoundary = truncated.lastIndexOf("\n\n");
  const cut = lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated;
  const summary = `[... ${originalSize} bytes compacted to ${Buffer.byteLength(cut, "utf8")} bytes ...]\n\n`;
  return {
    compacted: summary + cut,
    originalSize,
    compactedSize: Buffer.byteLength(summary + cut, "utf8"),
  };
}

const HANDLERS: Record<string, (input: any) => unknown> = {
  "json.stringify": jsonStringify,
  "json.parse": jsonParse,
  "serialize.session": serializeSession,
  "compact.context": compactContext,
};

// ── Message loop ───────────────────────────────────────────────

port.on("message", (msg: { id: string; handler: string; input: unknown }) => {
  try {
    const handler = HANDLERS[msg.handler];
    if (!handler) {
      port.postMessage({
        id: msg.id,
        ok: false,
        error: `Unknown handler: ${msg.handler}`,
      });
      return;
    }
    const result = handler(msg.input);
    port.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    port.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
