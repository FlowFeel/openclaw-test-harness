/**
 * oc-topic-manager — telethon-client unit specs.
 *
 * @behavior
 * Pure-seam coverage for the molton API client: normalization,
 * mapping, URL construction, page-following, error surfacing, and
 * bearer-token wrapping. All fetches use an injected fake fetch — no
 * network I/O in these specs.
 *
 * @dft
 * - Every case is a pure function call with deterministic inputs.
 * - Fetch injection proves the seam contracts without a live server.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeForumTopic,
  toTopicMeta,
  buildTopicsUrl,
  fetchAllTopics,
  withBearerToken,
  type ForumTopic,
} from "../../../src/plugins/oc-topic-manager/src/telethon-client.js";

const forumTopic = (over: Partial<ForumTopic> = {}): ForumTopic => ({
  id: 82385,
  chat_id: "-1003842172831",
  title: "Flow agent",
  pinned: false,
  closed: false,
  hidden: false,
  is_general: false,
  unread_count: 0,
  last_message_id: 42,
  last_message_date: "2026-09-06T10:00:00Z",
  last_message: "hi",
  ...over,
});

describe("normalizeForumTopic", () => {
  it("normalizes a molton ForumTopic with all fields", () => {
    const raw = {
      id: 82385,
      chat_id: "-1003842172831",
      title: "Flow agent",
      pinned: true,
      closed: false,
      hidden: false,
      is_general: false,
      unread_count: 7,
      last_message_id: 42,
      last_message_date: "2026-09-06T10:00:00Z",
      last_message: "hello",
    };
    const out = normalizeForumTopic(raw);
    expect(out).toEqual(forumTopic({ pinned: true, unread_count: 7 }));
  });

  it("degrades missing optional fields to safe defaults", () => {
    const out = normalizeForumTopic({ id: 5, chat_id: "c", title: "t" });
    expect(out).toEqual({
      id: 5,
      chat_id: "c",
      title: "t",
      pinned: false,
      closed: false,
      hidden: false,
      is_general: false,
      unread_count: 0,
      last_message_id: null,
      last_message_date: null,
      last_message: null,
    });
  });

  it("rejects non-objects and non-numeric ids", () => {
    expect(normalizeForumTopic(null)).toBeNull();
    expect(normalizeForumTopic(undefined)).toBeNull();
    expect(normalizeForumTopic("x")).toBeNull();
    expect(normalizeForumTopic({ id: "bogus" })).toBeNull();
    expect(normalizeForumTopic({ id: -1 })).toBeNull();
    expect(normalizeForumTopic({ id: 1.5 })).toBeNull();
  });

  it("defaults last_message_date to null when missing (not ''), so callers distinguish unknown", () => {
    const out = normalizeForumTopic({ id: 1, chat_id: "c", title: "t" });
    expect(out?.last_message_date).toBeNull();
  });
});

describe("toTopicMeta", () => {
  it("maps last_message_date to lastActiveAt", () => {
    const meta = toTopicMeta(forumTopic());
    expect(meta.id).toBe(82385);
    expect(meta.lastActiveAt).toBe("2026-09-06T10:00:00Z");
    expect(meta.pinned).toBe(false);
  });

  it("maps absent dates to empty lastActiveAt", () => {
    const meta = toTopicMeta(forumTopic({ last_message_date: null }));
    expect(meta.lastActiveAt).toBe("");
  });

  it("normalizes pinned from the payload", () => {
    expect(toTopicMeta(forumTopic({ pinned: true })).pinned).toBe(true);
  });
});

describe("buildTopicsUrl", () => {
  it("joins base URL and chat id path", () => {
    const url = buildTopicsUrl("http://127.0.0.1:37337", "-1003842172831");
    expect(url).toBe("http://127.0.0.1:37337/chats/-1003842172831/topics");
  });

  it("strips trailing slashes from the base", () => {
    const url = buildTopicsUrl("http://host:37337/", "1");
    expect(url).toBe("http://host:37337/chats/1/topics");
  });

  it("adds cursor params only when present", () => {
    const url = buildTopicsUrl("http://host", "1", { offsetId: 82385, offsetTopic: 0 });
    expect(url).toContain("offset_id=82385");
    expect(url).toContain("offset_topic=0");
    expect(url).not.toContain("offset_date");
  });

  it("includes offset_date when given", () => {
    const url = buildTopicsUrl("http://host", "1", { offsetDate: "2026-09-01T00:00:00Z" });
    expect(url).toContain("offset_date=2026-09-01T00%3A00%3A00Z");
  });
});

describe("fetchAllTopics", () => {
  const page = (items: unknown[]) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ items }),
    }) as Response;

  it("fetches a single page and normalizes items", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return page([forumTopic(), { id: 73336, chat_id: "c", title: "Archived" }]);
    };
    const res = await fetchAllTopics("http://host", "-1003842172831", {
      fetchImpl,
      pageLimit: 100,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(2);
      expect(res.value[0].id).toBe(82385);
      expect(res.value[0].lastActiveAt).toBe("2026-09-06T10:00:00Z");
    }
    expect(calls).toHaveLength(1);
  });

  it("follows the cursor when a page is full", async () => {
    const full: unknown[] = [];
    for (let i = 300; i < 400; i++) full.push({ id: i, chat_id: "c", title: `t${i}` });
    const pages: unknown[][] = [full, [forumTopic()]];
    const fetchImpl = async (_url: string) => page(pages.shift() ?? []);
    const res = await fetchAllTopics("http://host", "c", { fetchImpl, pageLimit: 100 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toHaveLength(101);
  });

  it("stops on an empty page", async () => {
    let calls = 0;
    const fetchImpl = async (_url: string) => {
      calls++;
      return page([]);
    };
    const res = await fetchAllTopics("http://host", "c", { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([]);
    expect(calls).toBe(1);
  });

  it("returns ok:false with status on HTTP error", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response;
    const res = await fetchAllTopics("http://host", "c", { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("401");
  });

  it("drops malformed items instead of failing", async () => {
    const fetchImpl = async () => page([{ id: "bogus" }, null, "x", { id: 7, chat_id: "c" }]);
    const res = await fetchAllTopics("http://host", "c", { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.map((t) => t.id)).toEqual([7]);
  });

  it("surfaces transport exceptions as ok:false", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await fetchAllTopics("http://host", "c", { fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("withBearerToken", () => {
  it("adds an Authorization header to requests", async () => {
    let captured: RequestInit | undefined;
    const base = async (_url: string, init?: RequestInit) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
    };
    const authed = withBearerToken("tok-123", base);
    await authed("http://host/chats/1/topics");
    expect(captured?.headers).toEqual({ Authorization: "Bearer tok-123" });
  });
});