/**
 * OcTaskPlane — I/O Protocol wrapper.
 *
 * @behavior
 * Declares the Protocol types for TaskPlane persistence, output handles, and
 * subprocess execution, and provides crash-safe filesystem and process implementations.
 * Follows the atomic write pattern (serialize -> backup -> tmp -> rename).
 *
 * @invariants
 * - Protocol types (Reader/Writer/OutputAccessor/ProcessSpawner) are declared here.
 * - Logic files depend only on types, never on the implementation.
 * - Real implementations perform atomic crash-safe file I/O; tests inject doubles.
 *
 * @dft
 * - Protocol types and behaviors tested via unit and integration tests with mocks.
 * - No business logic here — only I/O wiring.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  copyFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import type { TaskPlaneRegistry } from "../../shared/types.js";

/** Default path for tasks.json */
export function getDefaultRegistryPath(): string {
  return resolve(
    process.env.HOME || "/home/node",
    ".openclaw/tasks/tasks.json"
  );
}

/** Default directory for task output handles */
export function getDefaultOutputDir(): string {
  return resolve(
    process.env.HOME || "/home/node",
    ".openclaw/tasks/output"
  );
}

export type TaskRegistryReader = (path?: string) => TaskPlaneRegistry | null;
export type TaskRegistryWriter = (data: TaskPlaneRegistry, path?: string) => void;
export type OutputAppender = (handlePath: string, chunk: string) => void;
export type OutputReader = (handlePath: string, options?: { tailLines?: number; maxBytes?: number }) => string;
export type PidChecker = (pid: number) => boolean;

export interface SpawnedProcess {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => void;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onError?: (err: Error) => void;
}

export type ProcessSpawner = (
  command: string,
  options: SpawnOptions
) => SpawnedProcess;

/**
 * Crash-safe read of task registry.
 */
export function readTaskRegistry(path?: string): TaskPlaneRegistry | null {
  const p = path ?? getDefaultRegistryPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    return JSON.parse(raw) as TaskPlaneRegistry;
  } catch {
    // If main file is corrupted, attempt backup recovery
    const bak = `${p}.bak`;
    if (existsSync(bak)) {
      try {
        const rawBak = readFileSync(bak, "utf8");
        return JSON.parse(rawBak) as TaskPlaneRegistry;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Crash-safe atomic write of task registry.
 * Invariant 5: serialize first, backup existing, write tmp, atomic rename.
 */
export function writeTaskRegistry(data: TaskPlaneRegistry, path?: string): void {
  const p = path ?? getDefaultRegistryPath();
  const dir = dirname(p);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Serialize first (throws before modifying filesystem if circular or invalid)
  const payload = JSON.stringify(data, null, 2);

  if (existsSync(p)) {
    copyFileSync(p, `${p}.bak`);
  }

  const tmp = `${p}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, p);
}

/**
 * Appends output chunk to the durable output handle.
 */
export function appendTaskOutput(handlePath: string, chunk: string): void {
  const dir = dirname(handlePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(handlePath, chunk, "utf8");
}

/**
 * Reads output from the durable output handle.
 */
export function readTaskOutput(
  handlePath: string,
  options?: { tailLines?: number; maxBytes?: number }
): string {
  if (!existsSync(handlePath)) {
    return "";
  }

  const raw = readFileSync(handlePath, "utf8");
  if (!options?.tailLines && !options?.maxBytes) {
    return raw;
  }

  let text = raw;
  if (options.maxBytes && text.length > options.maxBytes) {
    text = text.slice(text.length - options.maxBytes);
  }

  if (options.tailLines && options.tailLines > 0) {
    const hasTrailingNewline = text.endsWith("\n");
    const content = hasTrailingNewline ? text.slice(0, -1) : text;
    const lines = content.split("\n");
    if (lines.length > options.tailLines) {
      text = lines.slice(lines.length - options.tailLines).join("\n") + (hasTrailingNewline ? "\n" : "");
    }
  }

  return text;
}

/**
 * Checks if a specific PID is alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as { code?: string };
    // EPERM means the process exists but we lack permission to signal it
    return error.code === "EPERM";
  }
}

/**
 * Real subprocess spawner executing a command asynchronously.
 */
export function defaultProcessSpawner(
  command: string,
  options: SpawnOptions
): SpawnedProcess {
  const child = spawn(command, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
  });

  child.stdout?.on("data", (data: Buffer) => {
    options.onStdoutChunk?.(data.toString("utf8"));
  });

  child.stderr?.on("data", (data: Buffer) => {
    options.onStderrChunk?.(data.toString("utf8"));
  });

  child.on("exit", (code, signal) => {
    options.onExit?.(code, signal ? String(signal) : null);
  });

  child.on("error", (err) => {
    options.onError?.(err);
  });

  return {
    pid: child.pid,
    kill: (sig) => {
      child.kill(sig);
    },
  };
}
