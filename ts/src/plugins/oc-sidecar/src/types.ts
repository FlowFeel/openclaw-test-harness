/**
 * Local type declarations for the OC plugin API surface.
 *
 * These are minimal declarations that match the OC plugin SDK contract.
 * In production, the real types come from `openclaw/plugin-sdk/plugin-entry`.
 * In CI (without OC installed), these local declarations provide type safety.
 *
 * @dft: types are structural (duck-typed) — testable without the real SDK.
 */

// ── Typebox substitute (minimal) ──────────────────────────────

export const Type = {
  Object(properties: Record<string, unknown>) {
    return { type: "object", properties };
  },
  String(opts?: { description?: string }) {
    return { type: "string", ...opts };
  },
  Any(opts?: { description?: string }) {
    return { type: "any", ...opts };
  },
};

// ── Plugin API types ──────────────────────────────────────────

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface HookEvent {
  [key: string]: unknown;
}

export interface HookContext {
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface PluginApi {
  logger?: {
    info?: (msg: string) => void;
    error?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  registerHook: (
    events: string | string[],
    handler: (event: HookEvent) => Promise<void>,
    opts?: { priority?: number }
  ) => void;
  registerTool: (tool: ToolDefinition, opts?: Record<string, unknown>) => void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi, config?: Record<string, unknown>) => void;
}

// ── Minimal definePluginEntry ─────────────────────────────────

export function definePluginEntry(def: PluginDefinition): PluginDefinition {
  return def;
}
