/**
 * Topic Provisioning I/O Protocol — injectable filesystem abstraction and
 * fail-safe workspace scaffolding helper.
 *
 * @invariants
 * - All filesystem mutations flow through TopicProvisioningIO (A1, A5).
 * - scaffoldTopicWorkspace returns a typed CheckResult and never throws (A6).
 *
 * @dft
 * - InMemoryTopicProvisioningIO enables zero-disk unit & integration testing.
 */

import * as fs from "node:fs";
import type { CarePackageSkeleton } from "./logic.js";

export interface TopicProvisioningIO {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string, encoding?: BufferEncoding): void;
}

export class NodeFsTopicProvisioningIO implements TopicProvisioningIO {
  existsSync(path: string): boolean {
    return fs.existsSync(path);
  }

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    fs.mkdirSync(path, options);
  }

  writeFileSync(path: string, data: string, encoding: BufferEncoding = "utf-8"): void {
    fs.writeFileSync(path, data, encoding);
  }
}

export class InMemoryTopicProvisioningIO implements TopicProvisioningIO {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();

  existsSync(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  mkdirSync(path: string, _options?: { recursive?: boolean }): void {
    this.directories.add(path);
  }

  writeFileSync(path: string, data: string, _encoding?: BufferEncoding): void {
    this.files.set(path, data);
  }
}

export interface ScaffoldResult {
  ok: boolean;
  created: boolean;
  error?: string;
}

const WORKSPACE_SUBDIRS = ["docs", "scripts", "tests", "state"] as const;

export function scaffoldTopicWorkspace(
  io: TopicProvisioningIO,
  skeleton: CarePackageSkeleton,
  workspaceRoot: string,
): ScaffoldResult {
  const absolutePath = `${workspaceRoot}/${skeleton.carePackageRelativePath}`;
  try {
    if (io.existsSync(absolutePath)) {
      return { ok: true, created: false };
    }
    for (const sub of WORKSPACE_SUBDIRS) {
      io.mkdirSync(`${skeleton.workspacePath}/${sub}`, { recursive: true });
    }
    const archiveDir = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
    io.mkdirSync(archiveDir, { recursive: true });
    io.writeFileSync(absolutePath, skeleton.markdown, "utf-8");
    return { ok: true, created: true };
  } catch (err) {
    return { ok: false, created: false, error: String(err) };
  }
}
