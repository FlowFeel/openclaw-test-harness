/**
 * Simple in-memory session store for tests — no native dependencies.
 * Replaces better-sqlite3 for container environments without Python.
 */

export interface TestRecord {
  sessionKey: string
  status: string
  spawnedBy: string
  isSubagent: number
  startedAtMs: number | null
  endedAtMs: number | null
}

export class TestStore {
  private records: Map<string, TestRecord> = new Map()

  insert(record: TestRecord): void {
    this.records.set(record.sessionKey, record)
  }

  countActive(): number {
    const active = new Set(["running", "processing", "created", "dispatched"])
    let count = 0
    for (const r of this.records.values()) {
      if (active.has(r.status)) count++
    }
    return count
  }

  countChildren(parentKey: string): number {
    const active = new Set(["running", "processing", "created", "dispatched"])
    let count = 0
    for (const r of this.records.values()) {
      if (r.spawnedBy === parentKey && r.isSubagent && active.has(r.status)) count++
    }
    return count
  }

  getTimedOut(timeoutSeconds: number, nowMs?: number): string[] {
    const now = nowMs ?? Date.now()
    const result: string[] = []
    for (const r of this.records.values()) {
      if (
        r.isSubagent &&
        r.status === "running" &&
        r.startedAtMs &&
        !r.endedAtMs &&
        now - r.startedAtMs > timeoutSeconds * 1000
      ) {
        result.push(r.sessionKey)
      }
    }
    return result
  }

  clear(): void {
    this.records.clear()
  }
}
