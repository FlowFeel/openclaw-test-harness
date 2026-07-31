/**
 * Built-in worker handlers — CPU-heavy functions that should run
 * off the main event loop.
 *
 * Each handler is a pure function (input → output, no side effects).
 * They're registered by name and executed via the WorkerPool Protocol.
 *
 * Built-in handlers:
 * - "json.stringify" — JSON.stringify (heavy for large objects)
 * - "json.parse" — JSON.parse (heavy for large strings)
 * - "compact.context" — context compaction (regex, summarization)
 * - "serialize.session" — session state serialization
 *
 * Custom handlers can be added via pool.register("name", fn).
 */

import type { WorkerPool } from "./worker-pool.schema.js"

// ── JSON handlers ──────────────────────────────────────────────

export function jsonStringify(input: { data: unknown; indent?: number }): string {
  return JSON.stringify(input.data, null, input.indent)
}

export function jsonParse(input: { text: string }): unknown {
  return JSON.parse(input.text)
}

// ── Context compaction handler ─────────────────────────────────

export function compactContext(input: {
  transcript: string
  maxBytes: number
}): { compacted: string; originalSize: number; compactedSize: number } {
  const original = input.transcript
  const originalSize = Buffer.byteLength(original, "utf8")

  if (originalSize <= input.maxBytes) {
    return { compacted: original, originalSize, compactedSize: originalSize }
  }

  // Truncate to maxBytes, trying to break on a message boundary
  const truncated = original.slice(0, input.maxBytes)
  const lastBoundary = truncated.lastIndexOf("\n\n")
  const cut = lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated

  const summary = `[... ${originalSize} bytes compacted to ${Buffer.byteLength(cut, "utf8")} bytes ...]\n\n`
  const compacted = summary + cut

  return {
    compacted,
    originalSize,
    compactedSize: Buffer.byteLength(compacted, "utf8"),
  }
}

// ── Session serialization handler ──────────────────────────────

export function serializeSession(input: { session: Record<string, unknown> }): string {
  return JSON.stringify(input.session)
}

// ── Registration helper ────────────────────────────────────────

export function registerBuiltinHandlers(pool: WorkerPool): void {
  pool.register("json.stringify", jsonStringify)
  pool.register("json.parse", jsonParse)
  pool.register("compact.context", compactContext)
  pool.register("serialize.session", serializeSession)
}
