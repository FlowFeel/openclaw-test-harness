/**
 * Foundry type declarations — shared types for the plugin foundry.
 *
 * @behavior
 * Defines the data structures the foundry's pure seams operate on:
 * PluginTree (a plugin's files + parsed manifest), Violation (an axiom
 * breach), and ScaffoldParams (the inputs to plugin generation).
 *
 * @invariants
 * - All types are plain data (no methods, no I/O).
 * - Violation carries its own proof (file, line, message, severity).
 *
 * @dft
 * - Types only; no logic to test. Used by validate-logic.ts and scaffold.ts.
 */

/** A parsed OC plugin manifest (openclaw.plugin.json). */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  contracts?: {
    tools?: string[];
    hooks?: string[];
  };
  activation?: {
    onStartup?: boolean;
  };
  configSchema?: Record<string, unknown>;
}

/**
 * A plugin's file tree as seen by the pure validator. The validator never
 * touches the filesystem — it operates on this in-memory representation.
 */
export interface PluginTree {
  /** Plugin name (the directory name, e.g. "oc-session-guard"). */
  name: string;
  /** Parsed manifest, or null if the manifest is missing/invalid. */
  manifest: PluginManifest | null;
  /** Relative path → file content. Paths are relative to the plugin dir. */
  files: Map<string, string>;
}

/** An axiom violation found by the validator. Decisions carry their own proof. */
export interface Violation {
  /** Which axiom was breached (e.g. "pure-io-separation"). */
  axiom: string;
  /** The file where the violation was found (relative path). */
  file?: string;
  /** Human-readable explanation of the violation. */
  message: string;
  /** "error" fails CI; "warn" is advisory. */
  severity: "error" | "warn";
}

/** Inputs to the scaffolder (foundry new). */
export interface ScaffoldParams {
  /** Plugin name, e.g. "oc-my-plugin". */
  name: string;
  /** Hooks to wire, e.g. ["after_compaction", "session_end"]. */
  hooks: string[];
  /** Tools to register, e.g. ["my_health", "my_cleanup"]. */
  tools: string[];
  /** Human-readable description for the manifest. */
  description?: string;
}

/** The output of the scaffolder: a map of relative path → file content. */
export type GeneratedFiles = Map<string, string>;
