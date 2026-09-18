/**
 * telethon-client — typed HTTP client for the molton Telethon server.
 *
 * @behavior
 * I/O seam (impure by design): fetches forum topics from the molton API
 * (`GET /chats/{chat_id}/topics`) with cursor pagination
 * (offset_id / offset_topic / offset_date). Normalization of a single
 * payload item is exported as the PURE `normalizeForumTopic` so the
 * mapping is unit-testable without I/O.
 *
 * @dft
 * - The fetch implementation is injectable (defaults to globalThis.fetch)
 *   so integration specs can stub the API without a real server.
 * - URL construction is isolated (buildTopicsUrl) — one function, no
 *   string-splatting in the loop.
 * - Errors surface as a typed result, never thrown from the seam.
 *
 * @invariants
 * - No OC core files modified.
 * - Does not know about sessions.json — registry-client owns that.
 */

import type { TopicMeta } from "./types.js";

/** A topic as the molton API returns it (fields we consume). */
export interface ForumTopic {
  id: number;
  chat_id: string;
  title: string;
  pinned?: boolean;
  closed?: boolean;
  hidden?: boolean;
  is_general?: boolean;
  unread_count?: number;
  last_message_id?: number | null;
  last_message_date?: string | null;
  last_message?: string | null;
}

/** A paginated topics response from the molton API. */
export interface TopicsList {
  items: ForumTopic[];
  chat_id: string;
  limit: number;
  offset_id?: number;
  offset_topic?: number;
  offset_date?: string | null;
}

/** Transport-agnostic result of a fetch attempt. */
export type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Normalize one molton ForumTopic into the pure TopicMeta shape.
 * Unknown or missing fields degrade to safe defaults; a non-object
 * input yields null (callers drop nulls).
 */
export function normalizeForumTopic(raw: unknown): ForumTopic | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id <= 0) return null;
  return {
    id: r.id,
    chat_id: typeof r.chat_id === "string" ? r.chat_id : "",
    title: typeof r.title === "string" ? r.title : "",
    pinned: r.pinned === true,
    closed: r.closed === true,
    hidden: r.hidden === true,
    is_general: r.is_general === true,
    unread_count: typeof r.unread_count === "number" ? r.unread_count : 0,
    last_message_id: typeof r.last_message_id === "number" ? r.last_message_id : null,
    last_message_date: typeof r.last_message_date === "string" ? r.last_message_date : null,
    last_message: typeof r.last_message === "string" ? r.last_message : null,
  };
}

/** True when the item has a usable last-activity timestamp. */
function asDate(value: string | null | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

/** Map a normalized ForumTopic into TopicMeta (id + title + activity). */
export function toTopicMeta(topic: ForumTopic): TopicMeta {
  return {
    id: topic.id,
    title: topic.title,
    messageCount: 0,
    lastActiveAt: asDate(topic.last_message_date),
    pinned: topic.pinned === true,
  };
}

/** Build the topics-list URL for one page. Pure on inputs. */
export function buildTopicsUrl(
  baseUrl: string,
  chatId: string,
  cursor?: { offsetId?: number; offsetTopic?: number; offsetDate?: string | null }
): string {
  const url = new URL(
    `/chats/${encodeURIComponent(String(chatId))}/topics`,
    baseUrl.replace(/\/+$/, "")
  );
  if (cursor?.offsetId) url.searchParams.set("offset_id", String(cursor.offsetId));
  if (cursor?.offsetTopic) url.searchParams.set("offset_topic", String(cursor.offsetTopic));
  if (cursor?.offsetDate) url.searchParams.set("offset_date", cursor.offsetDate);
  return url.toString();
}

/**
 * Fetch every page of forum topics for a chat, following the molton
 * cursor. Stops when a page has fewer items than the limit (or an empty
 * page). The caller supplies the auth token via `init` headers or the
 * injectable fetch wrapper.
 */
export async function fetchAllTopics(
  baseUrl: string,
  chatId: string,
  opts: { fetchImpl?: FetchLike; pageLimit?: number } = {}
): Promise<FetchResult<TopicMeta[]>> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pageLimit = opts.pageLimit ?? 100;
  const cursor: { offsetId?: number; offsetTopic?: number; offsetDate?: string | null } = {};

  try {
    const items: TopicMeta[] = [];
    for (let page = 0; page < 200; page++) {
      const url = buildTopicsUrl(baseUrl, chatId, cursor);
      const resp = await fetchImpl(url);
      if (!resp.ok) {
        return { ok: false, error: `topics fetch failed: HTTP ${resp.status}` };
      }
      const body = (await resp.json()) as { items?: unknown[] };
      if (!Array.isArray(body.items) || body.items.length === 0) break;
      const normalized = body.items
        .map(normalizeForumTopic)
        .filter((t): t is ForumTopic => t !== null)
        .map(toTopicMeta);
      items.push(...normalized);
      if (body.items.length < pageLimit) break;
      const last = normalized[normalized.length - 1];
      if (!last) break;
      cursor.offsetId = last.id;
      cursor.offsetTopic = 0;
    }
    return { ok: true, value: items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Create a bearer-token fetch wrapper for the molton API. */
export function withBearerToken(token: string, fetchImpl?: FetchLike): FetchLike {
  const base = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return (url, init) => base(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
}