/**
 * Stateful In-Memory PluginApi Protocol Double (Axiom A5).
 *
 * @invariants
 * - Real stateful implementation of PluginApi — zero vi.fn() shims.
 * - Records hooks, tools, structured logs, and enqueued next-turn injections.
 * - Exposes deterministic helpers to invoke hooks and tools in integration tests.
 *
 * @dft
 * - Used across Tier 2 integration & manifest specs and Tier 3 BDD step suites.
 */

import type {
  PluginApi,
  ToolDefinition,
  ToolResult,
  HookEvent,
  HookContext,
} from "../../src/plugins/shared/types.js";

export interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface CapturedInjection {
  sessionKey?: string;
  text: string;
  idempotencyKey?: string;
}

export type HookHandler = (
  event: HookEvent,
  ctx?: HookContext,
) => Promise<unknown> | unknown;

export class InMemoryPluginApi implements PluginApi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly hooks = new Map<string, HookHandler[]>();
  readonly logs: CapturedLog[] = [];
  readonly injections: CapturedInjection[] = [];
  config?: unknown;
  pluginConfig?: unknown;

  readonly logger = {
    debug: (message: string) => {
      this.logs.push({ level: "debug", message });
    },
    info: (message: string) => {
      this.logs.push({ level: "info", message });
    },
    warn: (message: string) => {
      this.logs.push({ level: "warn", message });
    },
    error: (message: string) => {
      this.logs.push({ level: "error", message });
    },
  };

  readonly session = {
    workflow: {
      enqueueNextTurnInjection: async (payload: {
        sessionKey?: string;
        text: string;
        idempotencyKey?: string;
      }): Promise<{ enqueued: boolean; id?: string }> => {
        this.injections.push(payload);
        return { enqueued: true, id: `inj-${this.injections.length}` };
      },
    },
  };

  on(hookName: string, handler: HookHandler): void {
    const existing = this.hooks.get(hookName) ?? [];
    existing.push(handler);
    this.hooks.set(hookName, existing);
  }

  registerHook(
    events: string | string[],
    handler: (event: HookEvent) => Promise<unknown> | unknown,
  ): void {
    const list = Array.isArray(events) ? events : [events];
    for (const ev of list) {
      this.on(ev, handler);
    }
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  async dispatchHook(
    hookName: string,
    event: HookEvent = {},
    ctx?: HookContext,
  ): Promise<unknown[]> {
    const handlers = this.hooks.get(hookName) ?? [];
    const results: unknown[] = [];
    for (const handler of handlers) {
      results.push(await handler(event, ctx));
    }
    return results;
  }

  async executeTool(
    name: string,
    params: Record<string, unknown> = {},
    callId = "test-call",
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered on InMemoryPluginApi`);
    }
    return tool.execute(callId, params);
  }

  registeredToolNames(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  registeredHookNames(): string[] {
    return Array.from(this.hooks.keys()).sort();
  }
}
