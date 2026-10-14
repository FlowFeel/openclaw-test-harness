/**
 * OcDurableSidecar — I/O Protocol wrapper (HTTP).
 *
 * @behavior
 * Executes SidecarRequests against the sidecar HTTP API with a timeout.
 * The fetch implementation is injectable: tests pass a fake; production uses
 * globalThis.fetch against 127.0.0.1 (loopback only).
 *
 * @invariants
 * - No logic here — request construction/interpretation lives in the pure seam.
 * - Timeouts always abort via AbortController; no hanging calls.
 *
 * @dft
 * - Tested via integration specs with an injected fetch double.
 */

import type { SidecarRequest, SidecarResponse } from "./durable-sidecar-logic.js";

export type FetchJson = (
  request: SidecarRequest,
  timeoutMs: number,
) => Promise<SidecarResponse>;

export function makeHttpFetchJson(baseUrl: string): FetchJson {
  return async (request, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(baseUrl + request.path, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
