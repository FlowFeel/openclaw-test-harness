/**
 * H1: Sync I/O blocks the event loop, async doesn't (Tier 3 — statistical).
 *
 * @derivation
 * Derived from Axiom A1 (pure-io-separation): because the I/O cost is isolable
 * from the logic cost, we can measure the event-loop impact of an I/O operation
 * by scheduling a sentinel timer before the operation. If the operation blocks
 * the loop (sync I/O), the sentinel fires late. If it yields (async I/O), it
 * doesn't.
 *
 * This is the mechanism behind the "834ms P99" claim. We do NOT assert 834ms
 * (that's a production observation, environment-specific). We assert the
 * DIRECTION: sync blocks (measurable delay), async yields (delay stays small).
 * The bounds are generous — the point is directional, not exact.
 *
 * @axiom-boundary
 * A2 (determinism) does NOT apply here — this is I/O, not logic. The timing
 * is environment-dependent (disk speed, CPU speed, OS scheduler). That's why
 * this is Tier 3 (statistical) with generous bounds, not Tier 1 (deterministic).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { measureSyncBlock, measureAsyncYield } from "../support/event-loop-probe.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "efficiency-io-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

/** Generate a ~5MB JSON string (large enough to cause measurable blocking). */
function generateLargeJson(): string {
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    sessions[`topic:${i}`] = {
      model: "gpt-4o",
      updatedAt: Date.now(),
      messages: Array.from({ length: 20 }, (_, j) => ({
        role: j % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(200),
      })),
      compactionCheckpoints: Array.from({ length: 10 }, (_, j) => ({
        id: `ckpt-${j}`,
        data: "y".repeat(100),
      })),
    };
  }
  return JSON.stringify(sessions);
}

describe("H1: sync I/O blocks the event loop, async doesn't", () => {
  it("readFileSync of a 5MB file causes measurable event loop blocking", async () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, "sessions.json");
    const content = generateLargeJson();
    writeFileSync(filePath, content);
    expect(content.length).toBeGreaterThan(1_000_000); // multi-MB

    // Read 5 times to accumulate enough blocking for the sentinel to detect
    const delay = await measureSyncBlock(() => {
      for (let i = 0; i < 5; i++) {
        readFileSync(filePath, "utf8");
      }
    });

    // The sentinel fires after the sync block. delay = block time + ~1ms.
    // Generous bound: > 3ms means the sync read measurably blocked the loop.
    // (The setTimeout(0) clamp is ~1ms, so > 3ms means > 2ms of actual blocking.)
    expect(delay).toBeGreaterThan(3);
  });

  it("readFile (async) of a 5MB file does NOT cause significant event loop blocking", async () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, "sessions.json");
    const content = generateLargeJson();
    writeFileSync(filePath, content);

    const delay = await measureAsyncYield(async () => {
      // Read 5 times — async yields to the event loop each time
      for (let i = 0; i < 5; i++) {
        await readFile(filePath, "utf8");
      }
    });

    // The sentinel should fire quickly — async I/O yields.
    // Generous bound: < 50ms means the event loop wasn't significantly blocked.
    // (5 async reads of 5MB might take 20-40ms total, but the loop is free
    // during that time — the sentinel fires early.)
    expect(delay).toBeLessThan(50);
  });

  it("the sync-vs-async difference is directional (sync blocks more)", async () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, "sessions.json");
    writeFileSync(filePath, generateLargeJson());

    const syncDelay = await measureSyncBlock(() => {
      for (let i = 0; i < 5; i++) {
        readFileSync(filePath, "utf8");
      }
    });

    const asyncDelay = await measureAsyncYield(async () => {
      for (let i = 0; i < 5; i++) {
        await readFile(filePath, "utf8");
      }
    });

    // The directional claim: sync blocks more than async.
    // We don't assert a ratio (that's environment-specific). We assert the
    // direction: sync's sentinel delay exceeds async's sentinel delay.
    expect(syncDelay).toBeGreaterThan(asyncDelay);
  });
});
