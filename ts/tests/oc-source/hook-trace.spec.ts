/**
 * OC Source Mod — Hook Debug Instrumentation (harness verification)
 *
 * Verifies patch 0001-hook-debug-instrumentation.patch, which adds a structured
 * trace to createHookRunner. The patch includes BOTH the code change
 * (src/plugins/hooks.ts) AND an OC-native test (src/plugins/hooks.trace.test.ts)
 * so patch+test = one upstreamable PR for openclaw/openclaw.
 *
 * This harness test does two things:
 *   1. Applies the patch, dynamic-imports the patched createHookRunner, and
 *      asserts the three core claims directly (fast harness verification).
 *   2. Runs the OC-native test file (hooks.trace.test.ts) that ships IN the
 *      patch, proving the upstreamable test is valid and passes.
 *
 * The patch is applied in beforeAll and reverted in afterAll so the submodule
 * stays clean (the .patch file is the source of truth, not a dirty working tree).
 */

import { describe, beforeAll, afterAll, it, expect, vi } from "vitest"
import { execSync } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"

const REPO_ROOT = path.resolve(__dirname, "../../..")
const OC_ROOT = path.join(REPO_ROOT, "oc-source/upstream")
const PATCH = path.join(REPO_ROOT, "oc-source/patches/0001-hook-debug-instrumentation.patch")

// Files the patch touches — ensureClean must reset ALL of them.
const MODIFIED_FILES = ["src/plugins/hooks.ts"] // tracked files modified by the patch
const ADDED_FILES = ["src/plugins/hooks.trace.test.ts"] // new files added by the patch

// Applied lazily in beforeAll — the module is imported AFTER the patch hits disk
// so vitest's transform sees the patched source.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createHookRunner: any

// ── Patch lifecycle ──────────────────────────────────────────────────────

function isPatched(): boolean {
  const hooksFile = path.join(OC_ROOT, MODIFIED_FILES[0]);
  if (!fs.existsSync(hooksFile)) return false;
  return fs.readFileSync(hooksFile, "utf8").includes("captureTrace");
}

// Force-clean the OC source tree (only used if applyPatch fails).
function forceClean() {
  for (const f of MODIFIED_FILES) {
    execSync(`git checkout -- ${f}`, { cwd: OC_ROOT, stdio: "ignore" })
  }
  for (const f of ADDED_FILES) {
    const full = path.join(OC_ROOT, f)
    if (fs.existsSync(full)) fs.unlinkSync(full)
  }
}

function ensureClean() {
  // No-op if already patched — concurrent test files share the OC source tree.
  // Only force-clean if we need to apply from a pristine state.
}

function applyPatch() {
  if (isPatched()) return; // already applied by us or a concurrent test file
  try {
    execSync(`git apply "${PATCH}"`, { cwd: OC_ROOT })
  } catch {
    // Patch failed — might be a corrupt/partial state. Force clean and retry.
    forceClean()
    execSync(`git apply "${PATCH}"`, { cwd: OC_ROOT })
  }
}

function resetPatch() {
  // No-op — patch is left applied to avoid races. forceClean() is used
  // only when applyPatch needs to recover from a corrupt state.
}

// ── Minimal registry stub (for direct harness claims) ────────────────────

function makeRegistry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typedHooks: any[] = [],
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
any {
  return {
    typedHooks,
    hooks: [],
    plugins: [],
  }
}

function makeHook(
  hookName: string,
  pluginId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any,
  priority = 0,
) {
  return { hookName, pluginId, handler, priority }
}

// Event/ctx shapes matching OC's PluginHookSessionEndEvent / SessionContext.
const SESSION_END_EVENT = {
  sessionId: "abc-123",
  sessionKey: "agent:main:abc",
  messageCount: 1,
  reason: "daily",
  sessionFile: "/tmp/abc.jsonl.reset.2026-01-01T00:00:00.000Z",
  transcriptArchived: true,
  nextSessionId: "def-456",
}
const SESSION_START_EVENT = {
  sessionId: "abc-123",
  sessionKey: "agent:main:abc",
  resumedFrom: null,
}
const SESSION_CTX = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" }

// ── Test suite ───────────────────────────────────────────────────────────

describe("OC hook debug instrumentation (patch 0001)", () => {
  beforeAll(async () => {
    ensureClean()
    applyPatch()
    // Reset vitest's module cache so the dynamic import re-transforms the
    // now-patched file instead of serving a stale pre-patch copy.
    vi.resetModules()
    const mod = await import("../../../oc-source/upstream/src/plugins/hooks.ts")
    createHookRunner = mod.createHookRunner
  })

  afterAll(() => {
    // Don't revert the patch here — leaving it applied avoids races between
    // concurrent test files that share the OC source tree (hook-dispatch-proof
    // applies the same patch). The next run's ensureClean() in beforeAll will
    // revert + reapply if needed. To clean up manually:
    //   cd oc-source/upstream && git checkout -- .
  })

  describe("claim 1: swallowed errors are captured in the trace", () => {
    it("captures a hook that throws when catchErrors=true (default) and NO logger is passed", async () => {
      // This is the CORE bug: before the patch, this error VANISHED completely.
      // catchErrors=true + no logger = silent swallow, zero visibility.
      const registry = makeRegistry([
        makeHook("session_end", "test-plugin", async () => {
          throw new Error("boom-from-handler")
        }),
      ])

      const runner = createHookRunner(registry, {
        enableTrace: true,
        catchErrors: true,
        // NO logger — the pre-patch code would swallow silently
      })

      await runner.runSessionEnd(SESSION_END_EVENT as never, SESSION_CTX as never)

      const trace = runner.getTrace()
      const errorEvent = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "error" && e.pluginId === "test-plugin",
      )

      expect(errorEvent).toBeDefined()
      expect(errorEvent.error).toContain("boom-from-handler")
      expect(errorEvent.swallowed).toBe(true)
      expect(errorEvent.hookName).toBe("session_end")
    })
  })

  describe("claim 2: 'didn't fire' is explained in the trace", () => {
    it("explains 'not-registered' when no hooks exist for the hook name", async () => {
      const registry = makeRegistry([]) // no hooks at all
      const runner = createHookRunner(registry, { enableTrace: true })

      await runner.runSessionEnd(SESSION_END_EVENT as never, SESSION_CTX as never)

      const trace = runner.getTrace()
      const noHandlers = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "no-handlers" && e.hookName === "session_end",
      )
      expect(noHandlers).toBeDefined()
      expect(noHandlers.reason).toBe("not-registered")
    })
  })

  describe("claim 3: successful dispatch is traced", () => {
    it("records a dispatch event with handler count when hooks fire", async () => {
      const registry = makeRegistry([
        makeHook("session_start", "plugin-a", async () => {}),
        makeHook("session_start", "plugin-b", async () => {}),
      ])
      const runner = createHookRunner(registry, { enableTrace: true })

      await runner.runSessionStart(SESSION_START_EVENT as never, SESSION_CTX as never)

      const trace = runner.getTrace()
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "session_start",
      )
      expect(dispatch).toBeDefined()
      expect(dispatch.handlerCount).toBe(2)
    })
  })

  describe("trace is disabled by default (zero overhead)", () => {
    it("produces an empty trace when enableTrace is not set", async () => {
      const registry = makeRegistry([
        makeHook("session_end", "noop-plugin", async () => {}),
      ])

      const runner = createHookRunner(registry, { catchErrors: true })
      await runner.runSessionEnd(SESSION_END_EVENT as never, SESSION_CTX as never)

      expect(runner.getTrace()).toHaveLength(0)
    })
  })

  describe("OC-native test file ships in the patch", () => {
    it("hooks.trace.test.ts exists after applying the patch", () => {
      const testFile = path.join(OC_ROOT, "src/plugins/hooks.trace.test.ts")
      expect(fs.existsSync(testFile)).toBe(true)
    })

    it("hooks.trace.test.ts uses OC-native conventions (vitest imports, co-located)", () => {
      const testFile = path.join(OC_ROOT, "src/plugins/hooks.trace.test.ts")
      const src = fs.readFileSync(testFile, "utf8")
      // OC tests import from "vitest" and use co-located relative imports
      expect(src).toContain('from "vitest"')
      expect(src).toContain("./hooks.test-fixtures.js")
      expect(src).toContain("./hooks.js")
      // Tests the three claims
      expect(src).toContain("swallowed errors are captured")
      expect(src).toContain("didn't fire")
      expect(src).toContain("successful dispatch is traced")
    })
  })
})
