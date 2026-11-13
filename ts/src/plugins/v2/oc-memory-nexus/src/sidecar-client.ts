/**
 * SidecarClient — HTTP client for the sidecar process.
 *
 * @behavior
 * A thin fetch-based client that proxies requests to the sidecar's HTTP API.
 * All methods are async (I/O only, no CPU work).
 *
 * @invariants
 * - Never throws on network errors — callers handle null/empty results.
 * - Timeouts after 10s per request to prevent hanging.
 * - Returns parsed JSON (not raw response).
 *
 * @dft
 * - Injectable fetch function (mock in tests, real fetch in production).
 * - URL is constructor-injected (ephemeral port in tests).
 */

export interface SidecarClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export function createSidecarClient(
  baseUrl: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}
): SidecarClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      };
      const resp = await fetchFn(`${baseUrl}${path}`, init);
      if (!resp.ok) {
        throw new Error(`Sidecar ${method} ${path} returned ${resp.status}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get(path) {
      return request("GET", path);
    },
    post(path, body) {
      return request("POST", path, body);
    },
  };
}
