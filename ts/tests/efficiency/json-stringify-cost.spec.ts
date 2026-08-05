/**
 * H2: JSON.stringify scan costs more than statSync (Tier 3 — statistical).
 *
 * @derivation
 * Derived from Axiom A1 (pure-io-separation): the bloat scan loop is in the
 * hook handler (separable from file I/O), so we can measure its CPU cost
 * with in-memory data — no file read needed.
 *
 * The oc-compaction-helper before_prompt_build hook calls
 * `JSON.stringify(fieldValue).length` for every bloat field in every session.
 * With 100 sessions × 6 fields, that's 600 serializations just to count bytes
 * for a threshold check. The fix: use statSync(path).size (one syscall) or
 * skip byte counting entirely (the field-name check already tells us bloat
 * exists).
 *
 * This test measures the cost of the current approach vs the fix, proving
 * the anti-pattern is real and the fix is cheaper.
 *
 * @axiom-boundary
 * A2 (determinism) does NOT apply — CPU timing is environment-dependent.
 * Tier 3 with generous bounds. The point is directional: the scan loop is
 * measurably more expensive than statSync.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { SessionsMap } from "../../src/plugins/shared/session-cleanup.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "efficiency-scan-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

const BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

/** 100 sessions, each with 6 bloat fields of realistic sizes. */
function bloatedSessions(): SessionsMap {
  const sessions: SessionsMap = {};
  for (let i = 0; i < 100; i++) {
    sessions[`topic:${i}`] = {
      compactionCheckpoints: Array.from({ length: 50 }, (_, j) => ({
        id: `ckpt-${j}`, data: "x".repeat(100),
      })),
      systemPromptReport: { sections: Array.from({ length: 20 }, (_, j) => ({
        name: `s-${j}`, content: "y".repeat(200),
      })) },
      skillsSnapshot: Array.from({ length: 10 }, () => ({ desc: "z".repeat(300) })),
      contextBudgetStatus: { history: Array.from({ length: 30 }, () => ({ t: 1 })) },
      usageFamilySessionIds: Array.from({ length: 20 }, () => "id-".repeat(8)),
      lastHeartbeatText: "heartbeat-".repeat(200),
      model: "gpt-4o",
      updatedAt: Date.now(),
    };
  }
  return sessions;
}

describe("H2: JSON.stringify scan costs more than statSync", () => {
  it("the current scan loop (JSON.stringify per field) is measurably expensive", () => {
    const sessions = bloatedSessions();

    // The current approach: serialize every bloat field to count bytes
    const start = performance.now();
    let bloatBytes = 0;
    for (const entry of Object.values(sessions)) {
      if (typeof entry === "object" && entry !== null) {
        for (const field of BLOAT_FIELDS) {
          if (field in entry) {
            const fieldValue = (entry as Record<string, unknown>)[field];
            bloatBytes += JSON.stringify(fieldValue).length;
          }
        }
      }
    }
    const scanTime = performance.now() - start;

    // The scan did real work (600 serializations across 100 sessions)
    expect(bloatBytes).toBeGreaterThan(100_000); // meaningful amount of bloat
    // The scan took measurable CPU time. Generous bound — the point is
    // it's not free. On a fast machine this might be 1-5ms; slower 5-20ms.
    expect(scanTime).toBeGreaterThan(0.5);
  });

  it("statSync (one syscall) is cheaper than the scan loop", () => {
    const dir = makeTmpDir();
    const filePath = resolve(dir, "sessions.json");
    const sessions = bloatedSessions();
    writeFileSync(filePath, JSON.stringify(sessions));

    // Measure the scan loop
    const scanStart = performance.now();
    let bloatBytes = 0;
    for (const entry of Object.values(sessions)) {
      if (typeof entry === "object" && entry !== null) {
        for (const field of BLOAT_FIELDS) {
          if (field in entry) {
            const fieldValue = (entry as Record<string, unknown>)[field];
            bloatBytes += JSON.stringify(fieldValue).length;
          }
        }
      }
    }
    const scanTime = performance.now() - scanStart;

    // Measure statSync (the fix: one syscall for file size)
    const statStart = performance.now();
    const fileSize = statSync(filePath).size;
    const statTime = performance.now() - statStart;

    expect(fileSize).toBeGreaterThan(0);
    // statSync is a single syscall — should be sub-millisecond
    expect(statTime).toBeLessThan(5);

    // The directional claim: the scan loop costs more than statSync.
    // The scan does 600 serializations; statSync does 1 syscall.
    expect(scanTime).toBeGreaterThan(statTime);
  });

  it("the field-name check (boolean) is even cheaper — no serialization needed", () => {
    const sessions = bloatedSessions();

    // The minimal approach: just check if bloat fields exist (no serialization)
    const start = performance.now();
    let hasBloat = false;
    for (const entry of Object.values(sessions)) {
      if (typeof entry === "object" && entry !== null) {
        for (const field of BLOAT_FIELDS) {
          if (field in entry) {
            hasBloat = true;
            break;
          }
        }
        if (hasBloat) break;
      }
    }
    const checkTime = performance.now() - start;

    expect(hasBloat).toBe(true);
    // The boolean check should be sub-millisecond — no serialization at all
    expect(checkTime).toBeLessThan(5);
  });

  it("the scan loop scales linearly with session count (O(n) regression guard)", () => {
    // 100 sessions
    const sessions100 = bloatedSessions();
    const t100Start = performance.now();
    for (const entry of Object.values(sessions100)) {
      if (typeof entry === "object" && entry !== null) {
        for (const field of BLOAT_FIELDS) {
          if (field in entry) {
            JSON.stringify((entry as Record<string, unknown>)[field]).length;
          }
        }
      }
    }
    const t100 = performance.now() - t100Start;

    // 500 sessions (5x)
    const sessions500: SessionsMap = {};
    for (let i = 0; i < 500; i++) {
      sessions500[`topic:${i}`] = sessions100[`topic:${i % 100}`];
    }
    const t500Start = performance.now();
    for (const entry of Object.values(sessions500)) {
      if (typeof entry === "object" && entry !== null) {
        for (const field of BLOAT_FIELDS) {
          if (field in entry) {
            JSON.stringify((entry as Record<string, unknown>)[field]).length;
          }
        }
      }
    }
    const t500 = performance.now() - t500Start;

    // Linear scaling regression guard: 5x sessions should NOT take >15x time.
    // This catches accidental O(n²) behavior. The lower bound is omitted —
    // for sub-millisecond operations, the ratio is too noisy to assert a
    // minimum. The upper bound is the meaningful guard.
    const ratio = t500 / Math.max(t100, 0.001);
    expect(ratio).toBeLessThan(15); // not O(n²) — 5x data, <15x time
  });
});
