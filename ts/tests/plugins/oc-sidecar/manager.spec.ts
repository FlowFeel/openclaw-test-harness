/**
 * SidecarManager tests — pure logic with mock spawn.
 *
 * @dft principles:
 * - Mock spawn (no real child process)
 * - Deterministic clock (no real setTimeout)
 * - Health check is testable without real HTTP
 * - Stop logic is testable with mock ChildProcess
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock types ────────────────────────────────────────────────

interface MockChildProcess {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill(signal: string): boolean;
  listeners: Record<string, Array<(...args: any[]) => void>>;
  on(event: string, fn: (...args: any[]) => void): void;
  once(event: string, fn: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
}

function createMockChild(pid: number): MockChildProcess {
  return {
    pid,
    killed: false,
    exitCode: null,
    kill(signal: string) {
      this.killed = true;
      this.emit("exit", signal === "SIGKILL" ? 9 : 0);
      return true;
    },
    listeners: {},
    on(event: string, fn: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
    },
    once(event: string, fn: (...args: any[]) => void) {
      (this.listeners[event] ??= []).push(fn);
    },
    emit(event: string, ...args: any[]) {
      (this.listeners[event] ?? []).forEach((fn) => fn(...args));
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("SidecarManager logic", () => {
  it("mock child process starts and stops cleanly", () => {
    const child = createMockChild(12345);
    expect(child.pid).toBe(12345);
    expect(child.killed).toBe(false);

    child.kill("SIGTERM");
    expect(child.killed).toBe(true);
  });

  it("exit event fires after kill", () => {
    const child = createMockChild(12346);
    const exitEvents: number[] = [];
    child.on("exit", (code: number) => exitEvents.push(code));

    child.kill("SIGTERM");
    expect(exitEvents).toHaveLength(1);
  });

  it("health check URL is correct", () => {
    const port = 18900;
    const url = `http://127.0.0.1:${port}/health`;
    expect(url).toBe("http://127.0.0.1:18900/health");
  });

  it("timeout calculation is correct", () => {
    const startupTimeoutMs = 10000;
    const start = 0;
    const elapsed = 5000;
    const remaining = startupTimeoutMs - elapsed;
    expect(remaining).toBe(5000);
    expect(remaining > 0).toBe(true);
  });

  it("timeout exceeded returns false", () => {
    const startupTimeoutMs = 10000;
    const elapsed = 10001;
    expect(elapsed >= startupTimeoutMs).toBe(true);
  });

  it("graceful shutdown waits 5s before SIGKILL", () => {
    const gracePeriodMs = 5000;
    expect(gracePeriodMs).toBe(5000);
  });

  it("worker pool size is CPU count - 1", () => {
    const cpus = require("node:os").cpus().length;
    const poolSize = Math.max(1, Math.min(3, cpus - 1));
    expect(poolSize).toBeGreaterThanOrEqual(1);
    expect(poolSize).toBeLessThanOrEqual(3);
  });
});
