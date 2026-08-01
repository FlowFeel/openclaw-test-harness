/**
 * Worker-pool handler registry conformance specs (ticket #11).
 *
 * Proves the god-function anti-pattern is eliminated:
 *  - Acceptance #1: handlers live in one registry; `dispatch` is generic.
 *  - Acceptance #2: `dispatch` contains no handler-name literals, so adding a
 *    handler needs no dispatch edit.
 *  - Acceptance #3: the worker-thread path and the inline-fallback path return
 *    identical results for every built-in handler (no drift).
 *
 * Also asserts the patch's shared handlers conform to the pure functions in
 * `handlers.ts` (derived-from, not reimplemented) for the handlers that exist
 * in both surfaces.
 */
import { describe, it, expect } from "vitest"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCjsModule } from "../support/load-cjs.js"
import {
  jsonStringify,
  jsonParse,
  serializeSession,
  ipcTransfer,
  fanoutTopics,
} from "../../src/features/worker-pool/handlers.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const patchPath = resolve(__dirname, "../../patches/worker-pool.js")

const mod = loadCjsModule(patchPath) as {
  getPool: () => {
    execute: (handler: string, input: unknown) => Promise<unknown>
    stats: () => { active: number; completed: number; failed: number; poolSize: number }
  }
  dispatch: (handler: string, input: unknown) => unknown
  handlers: Record<string, (input: any) => unknown>
}
const { getPool, dispatch, handlers } = mod

// Deterministic fixtures (fanout.topics pins nowMs so both paths agree exactly).
const fixtures: Array<{ handler: string; input: unknown }> = [
  { handler: "json.stringify", input: { data: { a: 1, b: [2, 3] }, indent: 2 } },
  { handler: "json.stringify", input: { data: { nested: { ok: true } } } },
  { handler: "json.parse", input: { text: '{"x":42,"y":[1,2]}' } },
  { handler: "compact.transcript", input: { entries: [{ a: 1 }, { b: 2 }, { c: 3 }] } },
  { handler: "serialize.session", input: { session: { k: "v", n: 7 } } },
  { handler: "serialize.session", input: { session: "already-a-string" } },
  { handler: "ipc.transfer", input: { payload: { nested: { ok: true, arr: [1, 2] } } } },
  { handler: "fanout.topics", input: { topics: ["t1", "t2", "t3"], payload: { msg: "hi" }, nowMs: 1700000000000 } },
  { handler: "measure.size", input: { blocks: [{ arguments: { a: "x" } }, { arguments: { b: "yy" } }] } },
]

describe("worker-pool handler registry (#11) — single source of truth", () => {
  it("registry holds every built-in handler exactly once", () => {
    const names = Object.keys(handlers).sort()
    expect(names).toEqual([
      "compact.transcript",
      "fanout.topics",
      "ipc.transfer",
      "json.parse",
      "json.stringify",
      "measure.size",
      "serialize.session",
    ])
  })

  it("dispatch is generic — no handler-name literals, so adding a handler needs no dispatch edit", () => {
    const src = dispatch.toString()
    // Generic lookup, not a hand-maintained if/else over handler names.
    expect(src).toMatch(/handlers\[handler\]/)
    for (const name of Object.keys(handlers)) {
      expect(src).not.toContain(`'${name}'`)
      expect(src).not.toContain(`"${name}"`)
    }
  })

  for (const { handler, input } of fixtures) {
    it(`worker dispatch === inline dispatch for "${handler}"`, async () => {
      const pool = getPool()
      const viaWorker = await pool.execute(handler, input)
      const viaInline = dispatch(handler, input)
      expect(viaWorker).toEqual(viaInline)
    })
  }

  it("unknown handler rejects in the worker AND throws inline (consistent — no silent null)", async () => {
    const pool = getPool()
    await expect(pool.execute("does.not.exist", {})).rejects.toThrow(/Unknown handler/)
    expect(() => dispatch("does.not.exist", {})).toThrow(/Unknown handler/)
  })

  it("inline json.parse now works (previously drifted — inline was missing json.parse, returned null)", () => {
    // Regression guard for the drift #11 fixes: the old inline fallback had no
    // `json.parse` branch and silently returned null. Both paths now parse.
    const input = { text: '{"fixed":true}' }
    expect(dispatch("json.parse", input)).toEqual({ fixed: true })
  })
})

describe("worker-pool registry conformance with handlers.ts (derived-from, not reimplemented)", () => {
  // The patch (CJS, ships into OC) and handlers.ts (ESM, harness Protocol
  // surface) can't share a runtime module, so we assert conformance by result
  // for the handlers that exist in both surfaces.
  it("json.stringify agrees with handlers.ts jsonStringify (no replacer)", () => {
    const input = { data: { a: 1, b: [2, 3] }, indent: 2 }
    expect(dispatch("json.stringify", input)).toEqual(jsonStringify(input as any))
  })

  it("json.parse agrees with handlers.ts jsonParse", () => {
    const input = { text: '{"k":"v"}' }
    expect(dispatch("json.parse", input)).toEqual(jsonParse(input as any))
  })

  it("serialize.session agrees with handlers.ts serializeSession", () => {
    const input = { session: { k: "v", n: 7 } }
    expect(dispatch("serialize.session", input)).toEqual(serializeSession(input as any))
  })

  it("ipc.transfer agrees with handlers.ts ipcTransfer", () => {
    const input = { payload: { nested: { ok: true } } }
    expect(dispatch("ipc.transfer", input)).toEqual(ipcTransfer(input as any))
  })

  it("fanout.topics agrees with handlers.ts fanoutTopics (pinned nowMs)", () => {
    const input = { topics: ["t1", "t2"], payload: { m: "hi" }, nowMs: 1700000000000 }
    expect(dispatch("fanout.topics", input)).toEqual(fanoutTopics(input as any))
  })
})
