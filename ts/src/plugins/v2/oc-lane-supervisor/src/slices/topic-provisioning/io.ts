/**
 * Topic Provisioning I/O Interface & Concrete Adapters.
 *
 * @invariants
 * - All filesystem mutations encapsulated behind TopicProvisioningIO interface (Axiom 1 & 5).
 * - InMemoryTopicProvisioningIO provides full hermetic testing double with zero disk touches.
 */

import * as fs from "node:fs";

export interface TopicProvisioningIO {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  writeFileSync: (path: string, content: string, encoding?: BufferEncoding) => void;
}

/**
 * Concrete production adapter wrapping node:fs.
 */
export class NodeFsTopicProvisioningIO implements TopicProvisioningIO {
  existsSync(path: string): boolean {
    return fs.existsSync(path);
  }

  mkdirSync(path: string, options?: { recursive?: boolean }): void {
    fs.mkdirSync(path, options);
  }

  writeFileSync(path: string, content: string, encoding: BufferEncoding = "utf-8"): void {
    fs.writeFileSync(path, content, encoding);
  }
}

/**
 * Hermetic in-memory test double (Axiom 5).
 */
export class InMemoryTopicProvisioningIO implements TopicProvisioningIO {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();

  existsSync(path: string): boolean {
    return this.directories.has(path) || this.files.has(path);
  }

  mkdirSync(path: string, _options?: { recursive?: boolean }): void {
    this.directories.add(path);
  }

  writeFileSync(path: string, content: string, _encoding: BufferEncoding = "utf-8"): void {
    this.files.set(path, content);
  }
}
