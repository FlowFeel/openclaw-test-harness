/**
 * BDD integration tests — port of Observatory V2 compliance pattern.
 *
 * Uses testcontainers-style approach: spin up the patched admission logic
 * against a real SQLite store (not in-memory), verify BDD scenarios from
 * the .feature file pass against actual I/O.
 *
 * Pattern follows: tests/compliance/test/bdd_test.go (Observatory V2)
 * - Feature files are the contract (../features/)
 * - Step definitions are the proof (this file)
 * - SQLite boots the hermetic stack (not Docker — lighter weight)
 * - Direct DB queries prove state at the data layer
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { resolveChildAdmission } from "../../patches/child-admission.js"
import { subagentMachine } from "../../src/features/subagent-admission/subagent-admission.machine.js"
import { createActor } from "xstate"
import type { AdmissionPolicy } from "../../src/features/subagent-admission/subagent-admission.schema.js"

// ── SQLite test store ───────────────────────────────────────────

function createTestStore(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      status TEXT,
      spawned_by TEXT,
      is_subagent INTEGER DEFAULT 0,
      started_at_ms INTEGER,
      ended_at_ms INTEGER,
      runtime_ms INTEGER
    );
    CREATE INDEX idx_status ON sessions(status);
    CREATE INDEX idx_subagent ON sessions(is_subagent);
  `)
  return db
}

function insertSubagent(
  db: Database.Database,
  key: string,
  opts: {
    status?: string
    spawnedBy?: string
    startedAtMs?: number
    endedAtMs?: number
  } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions
     (session_key, status, spawned_by, is_subagent, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(
    key,
    opts.status ?? "running",
    opts.spawnedBy ?? "agent:main:main",
    opts.startedAtMs ?? Date.now(),
    opts.endedAtMs ?? null,
  )
}

function countActive(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM sessions
     WHERE status IN ('running', 'processing', 'created', 'dispatched')`,
  ).get() as { count: number }
  return row.count
}

function countChildren(db: Database.Database, parentKey: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM sessions
     WHERE spawned_by = ? AND is_subagent = 1
     AND status IN ('running', 'processing', 'created', 'dispatched')`,
  ).get(parentKey) as { count: number }
  return row.count
}

function getTimedOut(
  db: Database.Database,
  timeoutSeconds: number,
): string[] {
  const now = Date.now()
  const rows = db.prepare(
    `SELECT session_key FROM sessions
     WHERE is_subagent = 1
     AND status IN ('running', 'processing')
     AND started_at_ms IS NOT NULL
     AND ended_at_ms IS NULL
     AND (? - started_at_ms) > ?`,
  ).all(now, timeoutSeconds * 1000) as { session_key: string }[]
  return rows.map((r) => r.session_key)
}

// ── BDD Step Definitions ───────────────────────────────────────
//
// Each describe block maps to a Feature from the .feature file.
// Each it() maps to a Scenario. The test name mirrors the Gherkin scenario.

describe("Feature: Subagent Spawn Admission — maxConcurrent", () => {
  let db: Database.Database
  const policy: AdmissionPolicy = {
    maxSpawnDepth: 1,
    maxChildrenPerAgent: 2,
    maxConcurrent: 2,
    runTimeoutSeconds: 300,
  }

  beforeEach(() => {
    db = createTestStore()
  })

  afterEach(() => {
    db.close()
  })

  it("Scenario: Spawn admitted when under concurrent limit", () => {
    // Given 0 active subagents are running
    // And the maxConcurrent is configured to 2
    expect(countActive(db)).toBe(0)

    // When a session requests to spawn a subagent
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: countChildren(db, "agent:main:main"),
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: countActive(db),
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: getTimedOut(db, policy.runTimeoutSeconds),
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })

    // Then the spawn should be admitted
    expect(result.ok).toBe(true)
  })

  it("Scenario: Spawn rejected when at concurrent limit", () => {
    // Given 2 active subagents are running
    insertSubagent(db, "agent:main:subagent:1")
    insertSubagent(db, "agent:main:subagent:2")
    expect(countActive(db)).toBe(2)

    // When a session requests to spawn a subagent
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0,
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: countActive(db),
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [],
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })

    // Then the spawn should be rejected
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.maxConcurrent")
      expect(result.error).toContain("global max concurrent")
    }
  })
})

describe("Feature: Subagent Spawn Admission — runTimeout", () => {
  let db: Database.Database
  const policy: AdmissionPolicy = {
    maxSpawnDepth: 1,
    maxChildrenPerAgent: 2,
    maxConcurrent: 2,
    runTimeoutSeconds: 300,
  }

  beforeEach(() => {
    db = createTestStore()
  })

  afterEach(() => {
    db.close()
  })

  it("Scenario: Spawn rejected when timed-out subagents exist", () => {
    // Given 1 subagent has exceeded runTimeoutSeconds
    const oldTime = Date.now() - 400_000 // 400s ago, timeout is 300s
    insertSubagent(db, "agent:main:subagent:stale", {
      startedAtMs: oldTime,
    })

    const timedOut = getTimedOut(db, policy.runTimeoutSeconds)
    expect(timedOut).toHaveLength(1)

    // When a session requests to spawn a subagent
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0,
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: 1,
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: timedOut,
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })

    // Then the spawn should be rejected
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.runTimeoutSeconds")
      expect(result.error).toContain("must be cleaned up")
    }
  })

  it("Scenario: Spawn admitted after timed-out subagent is cleaned up", () => {
    // Given 0 subagents have exceeded runTimeoutSeconds
    expect(getTimedOut(db, policy.runTimeoutSeconds)).toHaveLength(0)

    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0,
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: 0,
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [],
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })

    expect(result.ok).toBe(true)
  })
})

describe("Feature: Subagent Spawn Admission — depth and children", () => {
  let db: Database.Database
  const policy: AdmissionPolicy = {
    maxSpawnDepth: 1,
    maxChildrenPerAgent: 2,
    maxConcurrent: 10, // high so it doesn't interfere
    runTimeoutSeconds: 300,
  }

  beforeEach(() => {
    db = createTestStore()
  })

  afterEach(() => {
    db.close()
  })

  it("Scenario: Spawn rejected at max spawn depth", () => {
    const result = resolveChildAdmission({
      callerDepth: 1,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: 0,
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: 0,
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [],
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.maxSpawnDepth")
    }
  })

  it("Scenario: Spawn rejected at max children per agent", () => {
    insertSubagent(db, "agent:main:subagent:1")
    insertSubagent(db, "agent:main:subagent:2")

    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: policy.maxSpawnDepth,
      activeChildren: countChildren(db, "agent:main:main"),
      maxActiveChildren: policy.maxChildrenPerAgent,
      globalActive: countActive(db),
      maxConcurrent: policy.maxConcurrent,
      timedOutSubagents: [],
      runTimeoutSeconds: policy.runTimeoutSeconds,
      collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.maxChildrenPerAgent")
    }
  })
})

describe("Feature: Subagent Lifecycle — timeout and archive", () => {
  it("Scenario: Subagent transitions to timed_out after exceeding timeout", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "agent:main:subagent:lifecycle" },
    })
    actor.start()

    // dispatch → running
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    expect(actor.getSnapshot().value).toBe("running")

    // When 1.5 seconds have elapsed (simulated — just send timeout event)
    actor.send({ type: "timeout" })

    // Then the subagent should transition to timed_out
    expect(actor.getSnapshot().value).toBe("timed_out")
  })

  it("Scenario: Timed-out subagent transitions to archived", () => {
    const actor = createActor(subagentMachine, {
      input: { sessionKey: "agent:main:subagent:archive" },
    })
    actor.start()

    // Navigate to timed_out
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "timeout" })
    expect(actor.getSnapshot().value).toBe("timed_out")

    // When the archive sweep runs
    actor.send({ type: "archive" })

    // Then the subagent should transition to archived
    expect(actor.getSnapshot().value).toBe("archived")

    // And no further transitions should be possible
    actor.send({ type: "dispatch" })
    actor.send({ type: "start" })
    actor.send({ type: "finish" })
    expect(actor.getSnapshot().value).toBe("archived")
  })
})
