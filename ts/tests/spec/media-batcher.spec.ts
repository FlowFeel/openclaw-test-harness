/**
 * Media batcher — pure logic tests.
 *
 * Tests the outbound media batching that collapses N sendDocument calls into
 * sendMediaGroup albums. Encodes the Telegram API constraints (max 10, same
 * chat, caption-on-first) and the reduction metric.
 *
 * @dft
 * - A1: no I/O — pure function calls only.
 * - A2: deterministic — order is insertion order, no randomness.
 * - A6: batchMediaSends returns a BatchResult with reductionPercent.
 */
import { describe, it, expect } from "vitest";
import {
  groupByChat,
  chunkGroups,
  buildGroup,
  batchMediaSends,
  shouldBatch,
  MAX_GROUP_SIZE,
  type MediaSend,
} from "../../src/plugins/shared/media-batcher.js";

function doc(chatId: string, path: string, caption?: string): MediaSend {
  return { chatId, type: "document", path, caption, sendId: path };
}

describe("groupByChat", () => {
  it("groups sends by chatId preserving insertion order", () => {
    const sends = [
      doc("chat:1", "a.pdf"),
      doc("chat:2", "b.pdf"),
      doc("chat:1", "c.pdf"),
    ];
    const byChat = groupByChat(sends);
    expect(byChat.size).toBe(2);
    expect(byChat.get("chat:1")?.map((s) => s.path)).toEqual(["a.pdf", "c.pdf"]);
    expect(byChat.get("chat:2")?.map((s) => s.path)).toEqual(["b.pdf"]);
  });

  it("returns empty map for no sends", () => {
    expect(groupByChat([]).size).toBe(0);
  });
});

describe("chunkGroups", () => {
  it("chunks into groups of at most MAX_GROUP_SIZE (10)", () => {
    const items = Array.from({ length: 25 }, (_, i) => doc("c", `${i}.pdf`));
    const chunks = chunkGroups(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });

  it("returns a single chunk for ≤10 items", () => {
    const items = Array.from({ length: 7 }, (_, i) => doc("c", `${i}.pdf`));
    const chunks = chunkGroups(items);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(7);
  });

  it("returns empty for no items", () => {
    expect(chunkGroups([])).toEqual([]);
  });

  it("respects a custom max", () => {
    const items = Array.from({ length: 7 }, (_, i) => doc("c", `${i}.pdf`));
    const chunks = chunkGroups(items, 3);
    expect(chunks).toHaveLength(3); // 3 + 3 + 1
    expect(chunks[2]).toHaveLength(1);
  });
});

describe("buildGroup", () => {
  it("uses the first item's caption as the group caption", () => {
    const items = [doc("c", "a.pdf", "First"), doc("c", "b.pdf", "Second")];
    const { group } = buildGroup(items);
    expect(group.caption).toBe("First");
    expect(group.chatId).toBe("c");
  });

  it("reports dropped captions from non-first items", () => {
    const items = [
      doc("c", "a.pdf", "First"),
      doc("c", "b.pdf", "Second"),
      doc("c", "c.pdf", "Third"),
    ];
    const { group, dropped } = buildGroup(items);
    expect(group.caption).toBe("First");
    expect(dropped).toHaveLength(2);
    expect(dropped[0].caption).toBe("Second");
    expect(dropped[1].caption).toBe("Third");
    expect(dropped[0].reason).toContain("first item");
  });

  it("reports no dropped captions when only the first has one", () => {
    const items = [doc("c", "a.pdf", "Only"), doc("c", "b.pdf")];
    const { dropped } = buildGroup(items);
    expect(dropped).toHaveLength(0);
  });
});

describe("batchMediaSends", () => {
  it("batches 10 documents to one chat into a single group (90% reduction)", () => {
    const sends = Array.from({ length: 10 }, (_, i) => doc("chat:1", `${i}.pdf`));
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].items).toHaveLength(10);
    expect(result.singleSends).toHaveLength(0);
    expect(result.apiCallCount).toBe(1);
    expect(result.originalApiCallCount).toBe(10);
    expect(result.reductionPercent).toBe(90);
    expect(result.batchedItemCount).toBe(10);
  });

  it("keeps a single send per chat as a single (no batch)", () => {
    const sends = [doc("chat:1", "a.pdf"), doc("chat:2", "b.pdf")];
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(0);
    expect(result.singleSends).toHaveLength(2);
    expect(result.apiCallCount).toBe(2);
    expect(result.reductionPercent).toBe(0);
  });

  it("batches 2 items (minimum for a group)", () => {
    const sends = [doc("chat:1", "a.pdf"), doc("chat:1", "b.pdf")];
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(1);
    expect(result.singleSends).toHaveLength(0);
    expect(result.apiCallCount).toBe(1);
    expect(result.reductionPercent).toBe(50);
  });

  it("splits >10 items per chat into multiple groups", () => {
    const sends = Array.from({ length: 12 }, (_, i) => doc("chat:1", `${i}.pdf`));
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].items).toHaveLength(10);
    expect(result.groups[1].items).toHaveLength(2);
    expect(result.apiCallCount).toBe(2);
    expect(result.reductionPercent).toBeCloseTo(83.33, 1);
  });

  it("handles 11 items: 10-group + 1 single (no 1-item groups)", () => {
    const sends = Array.from({ length: 11 }, (_, i) => doc("chat:1", `${i}.pdf`));
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].items).toHaveLength(10);
    expect(result.singleSends).toHaveLength(1);
    expect(result.apiCallCount).toBe(2);
  });

  it("batches per-chat independently", () => {
    const sends = [
      ...Array.from({ length: 3 }, (_, i) => doc("chat:1", `a${i}.pdf`)),
      ...Array.from({ length: 1 }, (_, i) => doc("chat:2", `b${i}.pdf`)),
      ...Array.from({ length: 5 }, (_, i) => doc("chat:3", `c${i}.pdf`)),
    ];
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(2); // chat:1 (3) + chat:3 (5)
    expect(result.singleSends).toHaveLength(1); // chat:2 (1)
    expect(result.apiCallCount).toBe(3);
    expect(result.originalApiCallCount).toBe(9);
    expect(result.reductionPercent).toBeCloseTo(66.67, 1);
  });

  it("reports dropped captions across all groups", () => {
    const sends = [
      doc("chat:1", "a.pdf", "Cap A"),
      doc("chat:1", "b.pdf", "Cap B"),
      doc("chat:2", "c.pdf", "Cap C"),
      doc("chat:2", "d.pdf", "Cap D"),
    ];
    const result = batchMediaSends(sends);

    expect(result.groups).toHaveLength(2);
    expect(result.droppedCaptions).toHaveLength(2); // b.pdf and d.pdf
    expect(result.droppedCaptions.map((d) => d.caption)).toEqual(["Cap B", "Cap D"]);
  });

  it("returns zero reduction for empty input", () => {
    const result = batchMediaSends([]);
    expect(result.groups).toHaveLength(0);
    expect(result.singleSends).toHaveLength(0);
    expect(result.reductionPercent).toBe(0);
    expect(result.apiCallCount).toBe(0);
  });

  it("preserves the first item's parseMode in the group", () => {
    const sends: MediaSend[] = [
      { chatId: "c", type: "document", path: "a.pdf", caption: "Hi", parseMode: "HTML" },
      { chatId: "c", type: "document", path: "b.pdf" },
    ];
    const result = batchMediaSends(sends);
    expect(result.groups[0].parseMode).toBe("HTML");
    expect(result.groups[0].caption).toBe("Hi");
  });
});

describe("shouldBatch", () => {
  it("returns true when any chat has ≥2 sends", () => {
    const sends = [doc("c", "a.pdf"), doc("c", "b.pdf"), doc("d", "e.pdf")];
    expect(shouldBatch(sends)).toBe(true);
  });

  it("returns false when every chat has exactly 1 send", () => {
    const sends = [doc("c1", "a.pdf"), doc("c2", "b.pdf")];
    expect(shouldBatch(sends)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(shouldBatch([])).toBe(false);
  });

  it("returns false for a single send", () => {
    expect(shouldBatch([doc("c", "a.pdf")])).toBe(false);
  });
});
