/**
 * Local type declarations for the OC plugin API surface.
 * These match the real OC plugin SDK contract.
 * In production, the real types come from `openclaw/plugin-sdk/plugin-entry`.
 */

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

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

/** Context passed to typed hook handlers (second argument to api.on). */
export interface HookContext {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  messageId?: string;
  channelId?: string;
  conversationId?: string;
  [key: string]: unknown;
}

export interface HookEvent {
  [key: string]: unknown;
}

/** Options for legacy registerHook (requires name). */
export interface HookOptions {
  name: string;
  priority?: number;
  timeoutMs?: number;
}

/** Options for typed api.on (no name needed — hook name IS the name). */
export interface TypedHookOptions {
  priority?: number;
  timeoutMs?: number;
  registrationId?: string;
}

export interface PluginApi {
  logger?: {
    info?: (msg: string) => void;
    error?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  /**
   * Register a TYPED lifecycle hook (gateway_start, session_end, etc.).
   * This is the correct API for lifecycle hooks — it registers to
   * typedHooks which is visible to hasHooks()/getHooksForName() and
   * actually dispatches. The handler receives (event, ctx).
   */
  on: (
    hookName: string,
    handler: (event: HookEvent, ctx?: HookContext) => Promise<unknown> | unknown,
    opts?: TypedHookOptions
  ) => void;
  /**
   * Legacy hook registration — registers to legacyInternalHooks which is
   * NOT visible to typed lifecycle dispatch. Use api.on() for lifecycle hooks.
   */
  registerHook: (
    events: string | string[],
    handler: (event: HookEvent) => Promise<unknown> | unknown,
    opts?: HookOptions
  ) => void;
  registerTool: (tool: ToolDefinition, opts?: Record<string, unknown>) => void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  register: (api: PluginApi, config?: Record<string, unknown>) => void;
}

export function definePluginEntry(def: PluginDefinition): PluginDefinition {
  return def;
}
