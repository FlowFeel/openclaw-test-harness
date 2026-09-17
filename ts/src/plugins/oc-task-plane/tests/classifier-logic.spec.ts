/**
 * Unit tests for Classifier Logic pure seam.
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic time.
 */

import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  KNOWN_LONG_RUNNER_PATTERNS,
  FOREGROUND_CAP_MS,
  type CommandHistoryRecord,
} from "../src/classifier-logic.js";

describe("classifier-logic (heuristics and history recall)", () => {
  it("identifies docker build commands as long runners", () => {
    const { result, report } = classifyCommand(
      "docker build -t my-image .",
      [],
      { nowMs: 1000 }
    );

    expect(result.isLongRunner).toBe(true);
    expect(result.category).toBe("docker");
    expect(result.recommendation).toBe("task_dispatch");
    expect(result.suggestedTimeoutMs).toBe(1800000);
    expect(result.advice).toContain("Docker build");
    expect(report.historyMatched).toBe(false);
  });

  it("identifies package manager install commands", () => {
    const commands = [
      "npm ci",
      "npm install --legacy-peer-deps",
      "composer install --no-dev",
      "cargo build --release",
      "pip install -r requirements.txt",
    ];

    for (const cmd of commands) {
      const { result } = classifyCommand(cmd, [], { nowMs: 1000 });
      expect(result.isLongRunner).toBe(true);
      expect(result.category).toBe("package-install");
      expect(result.recommendation).toBe("task_dispatch");
    }
  });

  it("identifies full test suites", () => {
    const commands = [
      "npm test",
      "vitest run tests/e2e/",
      "pytest -v tests/",
      "cargo test --all",
    ];

    for (const cmd of commands) {
      const { result } = classifyCommand(cmd, [], { nowMs: 1000 });
      expect(result.isLongRunner).toBe(true);
      expect(result.category).toBe("test-suite");
      expect(result.recommendation).toBe("task_dispatch");
    }
  });

  it("identifies data transfer and media commands", () => {
    const commands = [
      "rsync -avz /src /dest",
      "ffmpeg -i input.mp4 output.webm",
      "tar -czf archive.tar.gz /data",
    ];

    for (const cmd of commands) {
      const { result } = classifyCommand(cmd, [], { nowMs: 1000 });
      expect(result.isLongRunner).toBe(true);
      expect(result.category).toBe("data-media");
      expect(result.recommendation).toBe("task_dispatch");
    }
  });

  it("classifies standard short commands as safe for foreground execution", () => {
    const safeCommands = [
      "echo 'hello world'",
      "git status",
      "git branch",
      "ls -la",
      "cat package.json",
      "node -v",
    ];

    for (const cmd of safeCommands) {
      const { result, report } = classifyCommand(cmd, [], { nowMs: 1000 });
      expect(result.isLongRunner).toBe(false);
      expect(result.recommendation).toBe("foreground");
      expect(report.reason).toContain("No heuristic");
    }
  });

  it("triggers on history recall if a command class previously breached caps", () => {
    const history: CommandHistoryRecord[] = [
      {
        commandPrefix: "custom-pipeline.sh",
        hitTimeoutCap: true,
        durationMs: 630000,
        recordedAt: 500,
      },
    ];

    const { result, report } = classifyCommand(
      "custom-pipeline.sh --all",
      history,
      { nowMs: 1000 }
    );

    expect(result.isLongRunner).toBe(true);
    expect(result.category).toBe("history-recall");
    expect(result.recommendation).toBe("task_dispatch");
    expect(result.advice).toContain("Command previously hit");
    expect(report.historyMatched).toBe(true);
  });
});
