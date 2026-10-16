/**
 * Resume Delta Logic (M8) Unit Tests.
 *
 * @dft
 * - Pure: inline test data, zero filesystem/network access.
 * - Deterministic: mock timestamps injected into functions.
 * - Comprehensive coverage of all decision branches.
 */

import { describe, it, expect } from "vitest";
import {
  createCompactionSnapshot,
  computeFileDeltas,
  computeDeltaHash,
  shouldEmitDeltaNotice,
  formatResumeDeltaNotice,
} from "../../../src/plugins/oc-compaction-helper/src/resume-delta-logic.js";

describe("Resume Delta Logic (M8)", () => {
  it("creates a compaction snapshot with copied file timestamps", () => {
    const files = {
      "/docs/note-1.md": 1000,
      "/docs/note-2.md": 2000,
    };
    const snap = createCompactionSnapshot("ckpt-1", 5000, files);

    expect(snap.checkpointId).toBe("ckpt-1");
    expect(snap.timestampMs).toBe(5000);
    expect(snap.files).toEqual(files);

    // Verify immutability
    files["/docs/note-1.md"] = 9999;
    expect(snap.files["/docs/note-1.md"]).toBe(1000);
  });

  it("computes clean delta when no files change", () => {
    const snap = createCompactionSnapshot("ckpt-1", 1000, {
      "/docs/a.md": 1000,
      "/docs/b.md": 1000,
    });
    const current = {
      "/docs/a.md": 1000,
      "/docs/b.md": 1000,
    };

    const delta = computeFileDeltas(snap, current, 2000);
    expect(delta.hasChanges).toBe(false);
    expect(delta.modified).toEqual([]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.unchangedCount).toBe(2);
    expect(delta.elapsedMs).toBe(1000);

    const hash = computeDeltaHash(delta);
    expect(hash).toBe("clean");
    expect(shouldEmitDeltaNotice(undefined, hash, delta.hasChanges)).toBe(false);
    expect(formatResumeDeltaNotice(delta)).toBe("");
  });

  it("detects modified files when current mtime > snapshot mtime", () => {
    const snap = createCompactionSnapshot("ckpt-1", 1000, {
      "/docs/a.md": 1000,
      "/docs/b.md": 1000,
    });
    const current = {
      "/docs/a.md": 1500, // modified
      "/docs/b.md": 1000, // unchanged
    };

    const delta = computeFileDeltas(snap, current, 2000);
    expect(delta.hasChanges).toBe(true);
    expect(delta.modified).toEqual(["/docs/a.md"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.unchangedCount).toBe(1);

    const hash = computeDeltaHash(delta);
    expect(hash).toContain("/docs/a.md");
    expect(shouldEmitDeltaNotice(undefined, hash, delta.hasChanges)).toBe(true);

    const notice = formatResumeDeltaNotice(delta);
    expect(notice).toContain("# [RESUME STATE DELTA] 1 file(s) modified");
    expect(notice).toContain("• /docs/a.md");
    expect(notice).not.toContain("Added");
    expect(notice).not.toContain("Removed");
  });

  it("detects added and removed files across compaction checkpoint", () => {
    const snap = createCompactionSnapshot("ckpt-2", 1000, {
      "/docs/old.md": 1000,
      "/docs/kept.md": 1000,
    });
    const current = {
      "/docs/kept.md": 1000,
      "/docs/new.md": 1200,
    };

    const delta = computeFileDeltas(snap, current, 2000);
    expect(delta.hasChanges).toBe(true);
    expect(delta.modified).toEqual([]);
    expect(delta.added).toEqual(["/docs/new.md"]);
    expect(delta.removed).toEqual(["/docs/old.md"]);
    expect(delta.unchangedCount).toBe(1);

    const notice = formatResumeDeltaNotice(delta);
    expect(notice).toContain("2 file(s) modified");
    expect(notice).toContain("Added (1):");
    expect(notice).toContain("• /docs/new.md");
    expect(notice).toContain("Removed (1):");
    expect(notice).toContain("• /docs/old.md");
  });

  it("suppresses redundant emission when delta hash matches previous turn", () => {
    const snap = createCompactionSnapshot("ckpt-1", 1000, {
      "/docs/a.md": 1000,
    });
    const current = {
      "/docs/a.md": 2000,
    };

    const delta = computeFileDeltas(snap, current, 3000);
    const hash = computeDeltaHash(delta);

    // First turn after modification: should emit
    expect(shouldEmitDeltaNotice(undefined, hash, delta.hasChanges)).toBe(true);

    // Second turn with same delta: should NOT emit
    expect(shouldEmitDeltaNotice(hash, hash, delta.hasChanges)).toBe(false);

    // If another file modifies, new hash allows emission
    const newCurrent = {
      "/docs/a.md": 2000,
      "/docs/b.md": 3100,
    };
    const newDelta = computeFileDeltas(snap, newCurrent, 4000);
    const newHash = computeDeltaHash(newDelta);
    expect(newHash).not.toBe(hash);
    expect(shouldEmitDeltaNotice(hash, newHash, newDelta.hasChanges)).toBe(true);
  });
});
