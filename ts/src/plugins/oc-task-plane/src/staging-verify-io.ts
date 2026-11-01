/**
 * Staging Revision Verification I/O Seam (T-587)
 *
 * @behavior
 * Standalone network fetcher for staging revision metadata over HTTP(S).
 * Reads commit SHAs from headers (X-Git-Commit, X-Revision) or response body.
 *
 * @dft
 * Functions are standalone, injectable, and mockable.
 */

export interface FetchRevisionResult {
  ok: boolean;
  status?: number;
  payload?: unknown;
  error?: string;
}

export type RevisionFetcher = (
  url: string,
  timeoutMs?: number,
) => Promise<FetchRevisionResult>;

export async function defaultFetchStagingRevision(
  url: string,
  timeoutMs = 10000,
): Promise<FetchRevisionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "OpenClaw-StagingVerify/1.0",
      },
    });

    const commitHeader =
      res.headers.get("x-git-commit") ||
      res.headers.get("x-revision") ||
      res.headers.get("x-commit-sha");

    let payload: unknown;
    const text = await res.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    // If a header was present, enrich the payload
    if (commitHeader && typeof payload === "object" && payload !== null) {
      (payload as Record<string, unknown>)._headerCommit = commitHeader;
    } else if (commitHeader && typeof payload === "string") {
      payload = { _headerCommit: commitHeader, body: payload };
    }

    return {
      ok: res.ok,
      status: res.status,
      payload,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
