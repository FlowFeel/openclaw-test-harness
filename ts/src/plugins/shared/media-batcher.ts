/**
 * Media batcher — pure logic for batching outbound media sends into sendMediaGroup calls.
 *
 * @behavior
 * Given a list of media sends (documents, photos, videos) queued in a single
 * turn, groups them by chat and batches each group of 2-10 items into a single
 * sendMediaGroup API call. Single items per chat remain individual sends.
 * This reduces N gateway websocket round-trips to ceil(N/10), directly
 * addressing Gap 1 (outbound sendMediaGroup) and reducing the gateway bus
 * contention that caused the Sunday sendDocument timeout.
 *
 * @why
 * Telegram's Bot API supports sendMediaGroup: 2-10 media items sent to the
 * same chat in a single API call. Without batching, the agent's N sendDocument
 * tool calls become N separate gateway round-trips — N chances to hit the 30s
 * timeout under load. With batching, 10 documents to one chat become 1
 * round-trip. The orchestrator's `before_tool_call` hook collects media sends
 * within a turn and calls `batchMediaSends` to collapse them before dispatch.
 *
 * @invariants
 * - All functions are pure: input → output, no side effects, no I/O.
 * - Deterministic: no Date.now(), no Math.random(). Order is insertion order.
 * - batchMediaSends returns a BatchResult (the report, A6) — never void.
 * - Groups never exceed 10 items (Telegram API hard limit).
 * - Groups never mix chats (Telegram API requires same chat).
 * - Single items (1 per chat) are never batched (sendMediaGroup needs ≥2).
 * - Only the first item's caption is kept per group (Telegram API limitation);
 *   dropped captions are reported in the BatchResult for caller follow-up.
 *
 * @dft
 * - A1 (pure-io-separation): no imports, no I/O.
 * - A2 (determinism): no Date.now()/Math.random(); order is insertion order.
 * - A6 (check-result): batchMediaSends returns a BatchResult with reductionPercent.
 */

// ── Telegram API constraints ─────────────────────────────────

/** Telegram sendMediaGroup hard limit: 2-10 items per group. */
export const MAX_GROUP_SIZE = 10;
export const MIN_GROUP_SIZE = 2;

// ── Types ─────────────────────────────────────────────────────

export type MediaType = "document" | "photo" | "video" | "audio";

/**
 * A single media send request — one message tool call with a file path.
 * The orchestrator collects these within a turn before dispatch.
 */
export interface MediaSend {
  chatId: string;
  type: MediaType;
  /** File path or URL of the media to send. */
  path: string;
  /** Optional caption. In a group, only the first item's caption is used. */
  caption?: string;
  /** Optional parse mode (MarkdownV2, HTML) for the caption. */
  parseMode?: string;
  /** Optional caller-side id for correlating results back to the original send. */
  sendId?: string;
}

/**
 * A batched media group — one sendMediaGroup API call.
 * All items share the same chatId; the caption comes from the first item.
 */
export interface MediaGroup {
  chatId: string;
  items: MediaSend[];
  /** Caption for the album (from the first item). */
  caption?: string;
  /** Parse mode for the caption (from the first item). */
  parseMode?: string;
}

/** A caption that was dropped because it wasn't on the first item of a group. */
export interface DroppedCaption {
  sendId?: string;
  chatId: string;
  caption: string;
  reason: string;
}

/**
 * The batch result (A6 report). The caller dispatches `groups` as
 * sendMediaGroup calls and `singleSends` as individual sendDocument/sendPhoto
 * calls. `droppedCaptions` are follow-up text messages if needed.
 */
export interface BatchResult {
  groups: MediaGroup[];
  singleSends: MediaSend[];
  droppedCaptions: DroppedCaption[];
  /** Total media items received. */
  totalSends: number;
  /** Items that went into groups (not single sends). */
  batchedItemCount: number;
  /** API calls after batching: groups.length + singleSends.length. */
  apiCallCount: number;
  /** API calls without batching (one per send). */
  originalApiCallCount: number;
  /** Percentage of API calls saved by batching. */
  reductionPercent: number;
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Group media sends by chatId, preserving insertion order within each chat.
 *
 * Telegram's sendMediaGroup requires all items to go to the same chat, so
 * this is the first partitioning step.
 */
export function groupByChat(sends: MediaSend[]): Map<string, MediaSend[]> {
  const byChat = new Map<string, MediaSend[]>();
  for (const send of sends) {
    const list = byChat.get(send.chatId);
    if (list) {
      list.push(send);
    } else {
      byChat.set(send.chatId, [send]);
    }
  }
  return byChat;
}

/**
 * Split a list of items into chunks of at most `max` items.
 *
 * A chunk with exactly 1 item becomes a single send (sendMediaGroup needs ≥2).
 * The caller handles that distinction.
 */
export function chunkGroups(items: MediaSend[], max = MAX_GROUP_SIZE): MediaSend[][] {
  if (items.length === 0) return [];
  const chunks: MediaSend[][] = [];
  for (let i = 0; i < items.length; i += max) {
    chunks.push(items.slice(i, i + max));
  }
  return chunks;
}

/**
 * Build a MediaGroup from 2-10 items, extracting the caption from the first.
 *
 * Telegram's sendMediaGroup applies the caption and parse_mode of the first
 * item to the whole album. Captions on subsequent items are dropped and
 * reported so the caller can send them as follow-up text if needed.
 */
export function buildGroup(items: MediaSend[]): {
  group: MediaGroup;
  dropped: DroppedCaption[];
} {
  const dropped: DroppedCaption[] = [];
  const first = items[0];
  const group: MediaGroup = {
    chatId: first.chatId,
    items,
    caption: first.caption,
    parseMode: first.parseMode,
  };
  for (let i = 1; i < items.length; i++) {
    if (items[i].caption) {
      dropped.push({
        sendId: items[i].sendId,
        chatId: items[i].chatId,
        caption: items[i].caption as string,
        reason: "only the first item in a media group can have a caption",
      });
    }
  }
  return { group, dropped };
}

/**
 * Batch a list of media sends into sendMediaGroup calls and single sends.
 *
 * The algorithm:
 * 1. Group all sends by chatId (Telegram requires same-chat groups).
 * 2. Within each chat, chunk into groups of ≤10 (Telegram hard limit).
 * 3. Chunks of ≥2 items become MediaGroups; chunks of 1 become single sends.
 * 4. Extract the first item's caption per group; report dropped captions.
 *
 * Returns a BatchResult (A6 report) with the groups, singles, dropped captions,
 * and the API-call reduction percentage.
 */
export function batchMediaSends(sends: MediaSend[]): BatchResult {
  const groups: MediaGroup[] = [];
  const singleSends: MediaSend[] = [];
  const droppedCaptions: DroppedCaption[] = [];

  const byChat = groupByChat(sends);
  for (const items of byChat.values()) {
    const chunks = chunkGroups(items);
    for (const chunk of chunks) {
      if (chunk.length >= MIN_GROUP_SIZE) {
        const { group, dropped } = buildGroup(chunk);
        groups.push(group);
        droppedCaptions.push(...dropped);
      } else {
        singleSends.push(chunk[0]);
      }
    }
  }

  const totalSends = sends.length;
  const batchedItemCount = groups.reduce((sum, g) => sum + g.items.length, 0);
  const apiCallCount = groups.length + singleSends.length;
  const originalApiCallCount = totalSends;
  const reductionPercent =
    originalApiCallCount > 0
      ? ((originalApiCallCount - apiCallCount) / originalApiCallCount) * 100
      : 0;

  return {
    groups,
    singleSends,
    droppedCaptions,
    totalSends,
    batchedItemCount,
    apiCallCount,
    originalApiCallCount,
    reductionPercent,
  };
}

/**
 * Quick check: would batching these sends save any API calls?
 *
 * The `before_tool_call` hook uses this to decide whether to intervene.
 * If false, the sends pass through unmodified (no batching overhead).
 */
export function shouldBatch(sends: MediaSend[]): boolean {
  const byChat = groupByChat(sends);
  for (const items of byChat.values()) {
    if (items.length >= MIN_GROUP_SIZE) return true;
  }
  return false;
}
