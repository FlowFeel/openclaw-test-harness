/**
 * Unit tests for TaskPlane I/O Protocol wrapper.
 *
 * @dft
 * - File system operations tested using isolated temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTaskRegistry,
  readTaskRegistry,
  appendTaskOutput,
  readTaskOutput,
} from "../src/task-plane-io.js";
import type { TaskPlaneRegistry } from "../../shared/types.js";

describe("task-plane-io (crash-safe persistence & output handles)", () => {
  let tempDir: string;
  let regPath: string;
  let outputPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "task-plane-io-test-"));
    regPath = join(tempDir, "tasks.json");
    outputPath = join(tempDir, "output", "task-1.log");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("writes and reads registry atomically", () => {
    const registry: TaskPlaneRegistry = {
      version: 1,
      tasks: {
        "task-1": {
          id: "task-1",
          kind: "exec",
          payload: { command: "test" },
          owner: "session-a",
          timeoutMs: 60000,
          status: "queued",
          output_handle: outputPath,
          timestamps: { queuedAt: 1000 },
        },
      },
    };

    writeTaskRegistry(registry, regPath);

    const loaded = readTaskRegistry(regPath);
    expect(loaded).toEqual(registry);

    // Verify backup created on second write
    registry.version = 2;
    writeTaskRegistry(registry, regPath);
    expect(existsSync(`${regPath}.bak`)).toBe(true);

    const loaded2 = readTaskRegistry(regPath);
    expect(loaded2?.version).toBe(2);
  });

  it("recovers from .bak if the primary registry file is corrupted", () => {
    const registry: TaskPlaneRegistry = {
      version: 1,
      tasks: {},
    };

    // First write
    writeTaskRegistry(registry, regPath);
    // Second write to create .bak
    registry.version = 2;
    writeTaskRegistry(registry, regPath);

    // Corrupt primary file
    writeFileSync(regPath, "{ invalid json corrupt content !!!", "utf8");

    const recovered = readTaskRegistry(regPath);
    expect(recovered).not.toBeNull();
    // Should have recovered from .bak (version 1)
    expect(recovered?.version).toBe(1);
  });

  it("appends and reads output chunks with tail filtering", () => {
    appendTaskOutput(outputPath, "Line 1\n");
    appendTaskOutput(outputPath, "Line 2\n");
    appendTaskOutput(outputPath, "Line 3\n");
    appendTaskOutput(outputPath, "Line 4\n");

    const all = readTaskOutput(outputPath);
    expect(all).toBe("Line 1\nLine 2\nLine 3\nLine 4\n");

    const tail = readTaskOutput(outputPath, { tailLines: 2 });
    expect(tail).toBe("Line 3\nLine 4\n");

    const maxBytes = readTaskOutput(outputPath, { maxBytes: 7 });
    expect(maxBytes).toBe("Line 4\n");
  });

  it("reads repo shipped-state in current git repository", async () => {
    const { readRepoShippedState } = await import("../src/task-plane-io.js");
    const state = readRepoShippedState(process.cwd());
    expect(state.status).not.toBe("unknown");
    expect(state.lastCommitSha).toBeDefined();
    expect(typeof state.lastCommitSha).toBe("string");
    expect(state.lastCommitSha!.length).toBeGreaterThan(0);
  });

  it("handles non-git directory gracefully returning status unknown", async () => {
    const { readRepoShippedState } = await import("../src/task-plane-io.js");
    const state = readRepoShippedState(tempDir);
    expect(state.status).toBe("unknown");
    expect(state.lastCommitSha).toBeUndefined();
  });
});
