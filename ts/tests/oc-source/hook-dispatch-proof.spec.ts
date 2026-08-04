/**
 * Hook dispatch proof tests — proves that the specific hooks our plugins use
 * actually dispatch through OC's createHookRunner.
 *
 * This is the TDD gate: before implementing a plugin hook, we prove here
 * that createHookRunner dispatches it. If a hook doesn't dispatch here,
 * it won't fire in production no matter what we register.
 *
 * Uses the same patch lifecycle as hook-trace.spec.ts: applies patch 0001,
 * dynamic-imports the patched createHookRunner, then tests each hook name
 * that our plugins register for.
 *
 * @dft
 * - Pure: in-memory registry, no file system
 * - Deterministic: inline events, injected context
 * - CheckResult: trace events ARE the proof
 */

import { describe, beforeAll, afterAll, it, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OC_ROOT = path.join(REPO_ROOT, "oc-source/upstream");
const PATCH = path.join(REPO_ROOT, "oc-source/patches/0001-hook-debug-instrumentation.patch");

const MODIFIED_FILES = ["src/plugins/hooks.ts"];
const ADDED_FILES = ["src/plugins/hooks.trace.test.ts"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createHookRunner: any;

function ensureClean() {
  for (const f of MODIFIED_FILES) {
    execSync(`git checkout -- ${f}`, { cwd: OC_ROOT, stdio: "ignore" });
  }
  for (const f of ADDED_FILES) {
    const full = path.join(OC_ROOT, f);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
}

function applyPatch() {
  execSync(`git apply "${PATCH}"`, { cwd: OC_ROOT });
}

function resetPatch() {
  for (const f of MODIFIED_FILES) {
    execSync(`git checkout -- ${f}`, { cwd: OC_ROOT, stdio: "ignore" });
  }
  for (const f of ADDED_FILES) {
    const full = path.join(OC_ROOT, f);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
}

// ── Registry helpers ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRegistry(typedHooks: any[] = []): any {
  return { typedHooks, hooks: [], plugins: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeHook(hookName: string, pluginId: string, handler: any, priority = 0): any {
  return { hookName, pluginId, handler, priority };
}

// Minimal event/context shapes. The trace instrumentation doesn't validate
// event structure — it just records what was dispatched.
const CTX = {
  runId: "run-001",
  sessionId: "sess-001",
  sessionKey: "agent:main:telegram:group:-100:topic:1",
  agentId: "main",
  trigger: "user",
  workspaceDir: "/tmp/workspace",
};

// ── Plugin hook inventory ────────────────────────────────────────────────
//
// These are the hooks our plugins register. Each test proves the hook
// dispatches via createHookRunner. If a test fails here, the plugin
// hook registration is useless — OC won't call it.
//
// Plugin → Hook mapping:
//   compaction-helper:  before_prompt_build, before_compaction, after_compaction
//   context-cache:      before_prompt_build, gateway_start, gateway_stop
//   orchestrator:       gateway_start, gateway_stop, after_compaction, session_end,
//                        subagent_spawned, subagent_ended, model_call_started, model_call_ended
//   stream-relay:       gateway_start, gateway_stop, model_call_started
//   model-router:       model_call_started, model_call_ended
//   topic-worker-pool:  before_dispatch, before_agent_run, agent_end,
//                        subagent_spawning, subagent_ended, before_agent_reply

// ── Tests ────────────────────────────────────────────────────────────────

describe("Hook dispatch proof — plugin hooks", () => {
  beforeAll(async () => {
    ensureClean();
    applyPatch();
    vi.resetModules();
    const mod = await import("../../../oc-source/upstream/src/plugins/hooks.ts");
    createHookRunner = mod.createHookRunner;
  });

  afterAll(() => {
    resetPatch();
  });

  // ── TURN-LEVEL hooks (fire every conversation turn) ──────────────────

  describe("before_prompt_build (compaction-helper, context-cache)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("before_prompt_build", "compaction-helper", async () => {}),
        makeHook("before_prompt_build", "context-cache", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforePromptBuild(
        { messages: [], toolResults: [] },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "before_prompt_build"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(2);
    });

    it("records no-handlers when nothing registered", async () => {
      const registry = makeRegistry([]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforePromptBuild(
        { messages: [], toolResults: [] },
        CTX,
      );

      const trace = runner.getTrace();
      const noHandlers = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "no-handlers" && e.hookName === "before_prompt_build"
      );
      expect(noHandlers).toBeDefined();
      expect(noHandlers.reason).toBe("not-registered");
    });

    it("captures swallowed errors from handlers", async () => {
      const registry = makeRegistry([
        makeHook("before_prompt_build", "bad-plugin", async () => {
          throw new Error("before_prompt_build boom");
        }),
      ]);
      const runner = createHookRunner(registry, {
        enableTrace: true,
        catchErrors: true,
      });

      await runner.runBeforePromptBuild(
        { messages: [], toolResults: [] },
        CTX,
      );

      const trace = runner.getTrace();
      const error = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "error" && e.hookName === "before_prompt_build"
      );
      expect(error).toBeDefined();
      expect(error.error).toContain("before_prompt_build boom");
      expect(error.swallowed).toBe(true);
    });
  });

  describe("agent_end (compaction-helper proposed, orchestrator proposed, topic-worker-pool)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("agent_end", "compaction-helper", async () => {}),
        makeHook("agent_end", "orchestrator", async () => {}),
        makeHook("agent_end", "topic-worker-pool", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runAgentEnd(
        { messages: [], success: true, error: undefined, durationMs: 5000 },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "agent_end"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(3);
    });

    it("records no-handlers when nothing registered", async () => {
      const registry = makeRegistry([]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runAgentEnd(
        { messages: [], success: true, error: undefined, durationMs: 5000 },
        CTX,
      );

      const trace = runner.getTrace();
      const noHandlers = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "no-handlers" && e.hookName === "agent_end"
      );
      expect(noHandlers).toBeDefined();
      expect(noHandlers.reason).toBe("not-registered");
    });
  });

  describe("before_agent_run (topic-worker-pool)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("before_agent_run", "topic-worker-pool", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforeAgentRun(
        { runId: "run-001", prompt: "test" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "before_agent_run"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  describe("before_agent_reply (topic-worker-pool)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("before_agent_reply", "topic-worker-pool", async () => ({ handled: false })),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforeAgentReply(
        { cleanedBody: "test message" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "before_agent_reply"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  // ── MODEL-CALL-LEVEL hooks ──────────────────────────────────────────

  describe("model_call_started (orchestrator, stream-relay, model-router)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("model_call_started", "orchestrator", async () => {}),
        makeHook("model_call_started", "stream-relay", async () => {}),
        makeHook("model_call_started", "model-router", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runModelCallStarted(
        { provider: "openrouter", modelId: "glm-5-2", runId: "run-001" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "model_call_started"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(3);
    });
  });

  describe("model_call_ended (orchestrator, model-router)", () => {
    it("dispatches with handler count when registered", async () => {
      const registry = makeRegistry([
        makeHook("model_call_ended", "orchestrator", async () => {}),
        makeHook("model_call_ended", "model-router", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runModelCallEnded(
        { provider: "openrouter", modelId: "glm-5-2", runId: "run-001", durationMs: 2000, success: true },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "model_call_ended"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(2);
    });
  });

  // ── COMPACTION hooks ────────────────────────────────────────────────

  describe("before_compaction (compaction-helper)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("before_compaction", "compaction-helper", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforeCompaction(
        { sessionKey: "agent:main:telegram:group:-100:topic:1" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "before_compaction"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  describe("after_compaction (compaction-helper, orchestrator)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("after_compaction", "compaction-helper", async () => {}),
        makeHook("after_compaction", "orchestrator", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runAfterCompaction(
        { sessionKey: "agent:main:telegram:group:-100:topic:1" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "after_compaction"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(2);
    });
  });

  // ── SUBAGENT hooks ───────────────────────────────────────────────────

  describe("subagent_spawned (orchestrator)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("subagent_spawned", "orchestrator", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runSubagentSpawned(
        { sessionKey: "subagent:001", resolvedModel: "glm-5-2" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "subagent_spawned"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  describe("subagent_ended (orchestrator, topic-worker-pool)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("subagent_ended", "orchestrator", async () => {}),
        makeHook("subagent_ended", "topic-worker-pool", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runSubagentEnded(
        { sessionKey: "subagent:001" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "subagent_ended"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(2);
    });
  });

  // ── LIFECYCLE hooks ──────────────────────────────────────────────────

  describe("gateway_start (all plugins)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("gateway_start", "orchestrator", async () => {}),
        makeHook("gateway_start", "compaction-helper", async () => {}),
        makeHook("gateway_start", "context-cache", async () => {}),
        makeHook("gateway_start", "stream-relay", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runGatewayStart({}, CTX);

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "gateway_start"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(4);
    });
  });

  describe("gateway_stop (all plugins)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("gateway_stop", "orchestrator", async () => {}),
        makeHook("gateway_stop", "compaction-helper", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runGatewayStop({}, CTX);

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "gateway_stop"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(2);
    });
  });

  describe("session_end (orchestrator)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("session_end", "orchestrator", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runSessionEnd(
        {
          sessionId: "sess-001",
          sessionKey: "agent:main:telegram:group:-100:topic:1",
          messageCount: 10,
          reason: "daily",
          sessionFile: "/tmp/test.jsonl",
          transcriptArchived: true,
          nextSessionId: "sess-002",
        },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "session_end"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  // ── MESSAGE-LEVEL hooks ──────────────────────────────────────────────

  describe("before_dispatch (topic-worker-pool)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("before_dispatch", "topic-worker-pool", async () => ({ handled: false })),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runBeforeDispatch(
        { message: "test", sessionKey: "agent:main:telegram:group:-100:topic:1" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "before_dispatch"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  // ── SUBAGENT SPAWNING hook ──────────────────────────────────────────

  describe("subagent_spawning (topic-worker-pool)", () => {
    it("dispatches when registered", async () => {
      const registry = makeRegistry([
        makeHook("subagent_spawning", "topic-worker-pool", async () => {}),
      ]);
      const runner = createHookRunner(registry, { enableTrace: true });

      await runner.runSubagentSpawning(
        { sessionKey: "subagent:001", parentSessionKey: "agent:main:telegram:group:-100:topic:1" },
        CTX,
      );

      const trace = runner.getTrace();
      const dispatch = trace.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) => e.type === "dispatch" && e.hookName === "subagent_spawning"
      );
      expect(dispatch).toBeDefined();
      expect(dispatch.handlerCount).toBe(1);
    });
  });

  // ── Zero overhead when disabled ──────────────────────────────────────

  describe("trace disabled by default (zero overhead)", () => {
    it("all hooks produce empty trace when enableTrace not set", async () => {
      const registry = makeRegistry([
        makeHook("before_prompt_build", "test", async () => {}),
        makeHook("agent_end", "test", async () => {}),
        makeHook("model_call_started", "test", async () => {}),
      ]);
      const runner = createHookRunner(registry, { catchErrors: true });

      await runner.runBeforePromptBuild({ messages: [] }, CTX);
      await runner.runAgentEnd({ success: true, durationMs: 1000 }, CTX);
      await runner.runModelCallStarted({ modelId: "test" }, CTX);

      expect(runner.getTrace()).toHaveLength(0);
    });
  });
});
