/**
 * SidecarManager — starts and stops the standalone sidecar process.
 *
 * @behavior
 * Spawns a child Node.js process running the sidecar server
 * (`./sidecar-server.ts`). The sidecar owns the worker_threads pool,
 * SQLite registry, and telemetry collector. The plugin communicates
 * with it via HTTP on localhost.
 *
 * @invariants
 * - The sidecar is a separate process — crash isolation is OS-level.
 * - If the sidecar fails to start within `startupTimeoutMs`, the plugin
 *   continues without it (hooks degrade gracefully).
 * - `stopSidecar` sends SIGTERM, waits 5s, then SIGKILL if still alive.
 * - The sidecar's HTTP server binds to 127.0.0.1 only (no remote access).
 *
 * @dft
 * - `startSidecar` is testable with a mock `spawn` function (injectable).
 * - The sidecar server itself is a plain HTTP server, testable in isolation.
 * - Timeout logic is pure (testable with a deterministic clock).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SidecarHandle {
  process: ChildProcess;
  port: number;
  pid: number;
}

export interface StartSidecarOptions {
  port: number;
  workerThreads: number;
  startupTimeoutMs: number;
}

/**
 * Start the sidecar process.
 *
 * In production, this spawns a child Node process running the sidecar server.
 * In tests, this is mocked to start an in-process HTTP server.
 */
export async function startSidecar(
  opts: StartSidecarOptions
): Promise<SidecarHandle> {
  const sidecarScript = resolve(__dirname, "sidecar-server.ts");

  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    sidecarScript,
    "--port", String(opts.port),
    "--workers", String(opts.workerThreads),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OC_SIDECAR_MODE: "production",
    },
  });

  // Wait for the sidecar to be ready (HTTP health check)
  const ready = await waitForHealthCheck(opts.port, opts.startupTimeoutMs);
  if (!ready) {
    // Kill the process if it didn't become ready
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    throw new Error(
      `Sidecar failed to start within ${opts.startupTimeoutMs}ms on port ${opts.port}`
    );
  }

  return {
    process: child,
    port: opts.port,
    pid: child.pid ?? -1,
  };
}

/**
 * Stop the sidecar process gracefully.
 * SIGTERM → wait 5s → SIGKILL.
 */
export async function stopSidecar(handle: SidecarHandle): Promise<void> {
  if (handle.process.killed || handle.process.exitCode !== null) {
    return; // Already dead
  }

  // Send SIGTERM
  try {
    handle.process.kill("SIGTERM");
  } catch {
    return; // Already dead
  }

  // Wait up to 5s for graceful shutdown
  const graceful = await waitForExit(handle.process, 5000);
  if (!graceful) {
    try {
      handle.process.kill("SIGKILL");
    } catch { /* already dead */ }
  }
}

// ── Internal helpers ──────────────────────────────────────────

async function waitForHealthCheck(
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) return true;
    } catch {
      // Not ready yet
    }
    await sleep(200);
  }
  return false;
}

async function waitForExit(
  proc: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
