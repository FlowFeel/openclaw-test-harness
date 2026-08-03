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

export interface HookEvent {
  [key: string]: unknown;
}

export interface HookOptions {
  name: string;
  priority?: number;
  timeoutMs?: number;
}

export interface PluginApi {
  logger?: {
    info?: (msg: string) => void;
    error?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  registerHook: (
    events: string | string[],
    handler: (event: HookEvent) => Promise<void> | void,
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
