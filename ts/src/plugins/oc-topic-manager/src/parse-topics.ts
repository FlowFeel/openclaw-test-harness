/**
 * parse-topics — normalize a Telegram forum topics payload into TopicMeta[].
 *
 * @behavior
 * Defensive parsing: entries that fail validation are dropped, never
 * thrown. `lastActiveAt` defaults to "" when the source lacks it.
 *
 * @dft
 * - Pure: payload in, TopicMeta[] out.
 * - Validity rules isolated in one predicate.
 */

import type { TopicMeta } from "./types.js";

/** Telegram Bot API forum topic shape (only fields we consume). */
interface RawTopic {
  message_thread_id?: unknown;
  title?: unknown;
  message_count?: unknown;
  pinned?: unknown;
  /** Optional: last activity, supplied by ingestion (the Bot API topic
   *  payload does NOT carry it — sources that can derive it set it here). */
  lastActiveAt?: unknown;
  last_active_at?: unknown;
}

/** True when the raw entry carries a numeric topic id. */
function hasNumericId(entry: unknown): entry is RawTopic {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as RawTopic).message_thread_id === "number"
  );
}

/** True when the value is a finite non-negative number. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Extract a last-activity timestamp from a raw entry. Accepts either spelling;
 * returns "" when absent or unparseable ("" means "unknown", never "now").
 */
function lastActiveAtOf(entry: RawTopic): string {
  const raw = entry.lastActiveAt ?? entry.last_active_at;
  if (typeof raw !== "string" || !raw) return "";
  return Number.isNaN(Date.parse(raw)) ? "" : raw;
}

/**
 * Normalize an unknown payload into TopicMeta[].
 * Accepts either a bare array or `{ topics: [...] }`.
 * Malformed entries are dropped.
 */
export function parseTopics(payload: unknown): TopicMeta[] {
  let raw: unknown = payload;
  if (!Array.isArray(raw) && typeof raw === "object" && raw !== null) {
    raw = (payload as { topics?: unknown }).topics;
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(hasNumericId).map((entry) => ({
    id: entry.message_thread_id as number,
    title: typeof entry.title === "string" ? entry.title : "",
    messageCount: isCount(entry.message_count) ? entry.message_count : 0,
    lastActiveAt: lastActiveAtOf(entry),
    pinned: entry.pinned === true,
  }));
}