/**
 * Tests for patched child-admission.ts — verifies both original behavior
 * and our extensions (maxConcurrent, runTimeoutSeconds).
 *
 * These tests run against the patched file in ts/patches/child-admission.ts.
 * They verify:
 * - All original OC guards still work (depth, children, swarm)
 * - New maxConcurrent guard blocks burst cascades
 * - New runTimeoutSeconds guard blocks spawning into saturated system
 * - Guard ordering: depth → concurrent → timeout → swarm → children
 * - Original behavior unchanged when extension fields are omitted
 */

import { describe, it, expect } from "vitest"
import { resolveChildAdmission } from "../../patches/child-admission.js"

// ── Original behavior (backwards compatibility) ───────────────

describe("resolveChildAdmission — original behavior", () => {
  it("admits when all limits within bounds", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects when depth exceeded", () => {
    const result = resolveChildAdmission({
      callerDepth: 1,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxSpawnDepth"); }  })

  it("rejects when children exceeded", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 2,
      maxActiveChildren: 2,
      collect: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxChildrenPerAgent"); }  })

  it("rejects when swarm total exceeded (collect mode)", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: true,
      totalChildren: 5,
      maxTotalChildren: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("tools.swarm.maxTotalPerGroup"); }  })

  it("rejects when swarm children exceeded (collect mode)", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 3,
      maxActiveChildren: 2,
      collect: true,
      totalChildren: 3,
      maxTotalChildren: 10,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("tools.swarm.maxChildrenPerGroup"); }  })
})

// ── Extension: maxConcurrent ───────────────────────────────────

describe("resolveChildAdmission — maxConcurrent extension", () => {
  it("admits when global active under concurrent limit", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 1,
      maxConcurrent: 2,
    })
    expect(result.ok).toBe(true)
  })

  it("rejects when global active at concurrent limit", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 2,
      maxConcurrent: 2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxConcurrent"); expect(result.error).toContain("concurrent"); }
  })

  it("concurrent checked before children", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 5,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 5,
      maxConcurrent: 2,
    })
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxConcurrent"); }  })
})

// ── Extension: runTimeoutSeconds ────────────────────────────────

describe("resolveChildAdmission — runTimeoutSeconds extension", () => {
  it("rejects when timed-out subagents exist", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 0,
      maxConcurrent: 2,
      timedOutSubagents: ["agent:main:subagent:stale"],
      runTimeoutSeconds: 300,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.governingCap).toBe("subagents.runTimeoutSeconds"); expect(result.error.toLowerCase()).toContain("timeout"); }
  })

  it("admits when no timed-out subagents", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 0,
      maxConcurrent: 2,
      timedOutSubagents: [],
      runTimeoutSeconds: 300,
    })
    expect(result.ok).toBe(true)
  })
})

// ── Guard ordering ─────────────────────────────────────────────

describe("resolveChildAdmission — guard ordering", () => {
  it("depth is checked first", () => {
    const result = resolveChildAdmission({
      callerDepth: 5,
      maxSpawnDepth: 1,
      activeChildren: 5,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 5,
      maxConcurrent: 2,
      timedOutSubagents: ["stale"],
      runTimeoutSeconds: 300,
    })
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxSpawnDepth"); }  })

  it("concurrent is checked before timeout", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 5,
      maxConcurrent: 2,
      timedOutSubagents: ["stale"],
      runTimeoutSeconds: 300,
    })
    if (!result.ok) { expect(result.governingCap).toBe("subagents.maxConcurrent"); }  })

  it("timeout is checked before children", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 5,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 0,
      maxConcurrent: 5,
      timedOutSubagents: ["stale"],
      runTimeoutSeconds: 300,
    })
    if (!result.ok) { expect(result.governingCap).toBe("subagents.runTimeoutSeconds"); }  })
})

// ── Backwards compatibility ────────────────────────────────────

describe("resolveChildAdmission — backwards compatibility", () => {
  it("works without extension fields (original OC behavior)", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 1,
      maxActiveChildren: 2,
      collect: false,
    })
    expect(result.ok).toBe(true)
  })

  it("undefined maxConcurrent is ignored", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
      globalActive: 100,
    })
    expect(result.ok).toBe(true)
  })

  it("undefined timedOutSubagents is ignored", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 1,
      activeChildren: 0,
      maxActiveChildren: 2,
      collect: false,
    })
    expect(result.ok).toBe(true)
  })
})
