/**
 * Stateful In-Memory I/O Protocol Doubles (Axiom A5).
 *
 * @invariants
 * - Zero vi.fn(), zero filesystem/network access.
 * - Every double records calls and maintains real in-process state.
 *
 * @dft
 * - Shared across Tier 2 integration and Tier 3 BDD test suites.
 */

import type { SessionsMap } from "../../src/plugins/shared/session-cleanup.js";

export class InMemorySessionsStore {
  private sessions: SessionsMap | null;
  writeCount = 0;

  constructor(initial: SessionsMap | null = {}) {
    this.sessions = initial ? structuredClone(initial) : null;
  }

  read = (_path?: string): SessionsMap | null => {
    return this.sessions ? structuredClone(this.sessions) : null;
  };

  write = (_path: string, next: SessionsMap): void => {
    this.sessions = structuredClone(next);
    this.writeCount += 1;
  };

  snapshot(): SessionsMap | null {
    return this.sessions ? structuredClone(this.sessions) : null;
  }
}

export interface SidecarRequestRecord {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export class InMemorySidecarClient {
  readonly requests: SidecarRequestRecord[] = [];
  private readonly getResponses = new Map<string, unknown>();
  private readonly postResponses = new Map<string, unknown>();
  available = true;

  setGetResponse(path: string, value: unknown): void {
    this.getResponses.set(path, value);
  }

  setPostResponse(path: string, value: unknown): void {
    this.postResponses.set(path, value);
  }

  async get(path: string): Promise<unknown> {
    this.requests.push({ method: "GET", path });
    if (!this.available) throw new Error("InMemorySidecarClient: unavailable");
    return this.getResponses.get(path) ?? { status: "healthy", poolSize: 2, active: 0 };
  }

  async post(path: string, body: unknown): Promise<unknown> {
    this.requests.push({ method: "POST", path, body });
    if (!this.available) throw new Error("InMemorySidecarClient: unavailable");
    return this.postResponses.get(path) ?? { ok: true, echo: body };
  }
}

export class InMemoryTranscriptStore {
  readonly files = new Map<string, string[]>();
  writeCount = 0;

  constructor(initial?: Record<string, string[]>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.files.set(k, [...v]);
      }
    }
  }

  read = (filePath: string): string[] | null => {
    const lines = this.files.get(filePath);
    return lines ? [...lines] : null;
  };

  write = (filePath: string, lines: string[]): boolean => {
    this.files.set(filePath, [...lines]);
    this.writeCount += 1;
    return true;
  };
}
