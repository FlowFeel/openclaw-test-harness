/**
 * Recall Registry Slice Adapter — binds recall_status, recall_verify, recall_catalogue,
 * gateway_start note scan, and before_agent_reply M4 linting.
 *
 * @invariants
 * - Zero any casts, zero empty catch blocks; I/O mediated via MemoryNotesLoader protocol.
 *
 * @dft
 * - Tested via oc-memory-nexus integration & manifest specs with InMemoryPluginApi.
 */

import { Type, type PluginApi, type HookEvent } from "../../../../../shared/types.js";
import { readNotesFromDisk, type MemoryNotesLoader } from "../../memory-recall-io.js";
import type { NoteRegistry } from "../../memory-recall-logic.js";
import { createRecallRegistryState } from "./state.js";
import {
  indexRawNoteFiles,
  applyM4ReplyLint,
  recordExternalTelemetryEvents,
  projectRecallStatus,
  projectRecallVerification,
  projectRecallCatalogue,
} from "./logic.js";

export interface RecallRegistrySliceHandle {
  getRegistry: () => NoteRegistry;
  reload: () => void;
  recordTelemetry: (events: Array<{ kind: string; arm: string }>) => void;
  onBeforeAgentReply: (event: HookEvent) => { handled: true; reply: { text: string; body: string } } | undefined;
}

export function bindRecallRegistrySlice(
  api: PluginApi,
  opts: { notesDir: string; subdirs: string[]; notesLoader?: MemoryNotesLoader },
): RecallRegistrySliceHandle {
  let state = createRecallRegistryState();
  const loader: MemoryNotesLoader = opts.notesLoader ?? readNotesFromDisk;

  function reload(): void {
    try {
      const rawFiles = loader(opts.notesDir, opts.subdirs);
      const res = indexRawNoteFiles(state, rawFiles);
      state = res.nextState;
      api.logger?.info?.(
        `[oc-memory-nexus] scanned ${res.scanned} files, indexed ${res.indexed} memory notes (${res.candidates} candidates).`,
      );
    } catch (err) {
      api.logger?.warn?.(`[oc-memory-nexus] note indexing failed: ${String(err)}`);
    }
  }

  api.registerTool({
    name: "recall_status",
    description:
      "Memory-recall registry and telemetry snapshot — notes indexed, kind breakdown, and fire/hit/follow metrics.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: JSON.stringify(projectRecallStatus(state), null, 2) }] };
    },
  });

  api.registerTool({
    name: "recall_verify",
    description: "Validate memory note frontmatter schemas and resolve watched file paths.",
    parameters: Type.Object({
      reload: Type.Optional(Type.Boolean({ description: "Reload notes from disk before verifying" })),
    }),
    async execute(_id, params) {
      if (params.reload === true) reload();
      return { content: [{ type: "text" as const, text: JSON.stringify(projectRecallVerification(state), null, 2) }] };
    },
  });

  api.registerTool({
    name: "recall_catalogue",
    description: "Browse memory note catalogue — 1-line index of notes, kinds, live pointers, and scope conditions.",
    parameters: Type.Object({
      kind: Type.Optional(Type.String({ description: "Filter catalogue by note kind" })),
      maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 50)" })),
    }),
    async execute(_id, params) {
      const kind = typeof params.kind === "string" ? params.kind : undefined;
      const maxEntries = typeof params.maxEntries === "number" ? params.maxEntries : 50;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(projectRecallCatalogue(state, { kind, maxEntries }), null, 2) },
        ],
      };
    },
  });

  return {
    getRegistry: () => state.registry,
    reload,
    recordTelemetry(events) {
      state = recordExternalTelemetryEvents(state, events).nextState;
    },
    onBeforeAgentReply(event: HookEvent) {
      if (state.registry.notes.size === 0) reload();
      const cleanedBody = typeof event.cleanedBody === "string" ? event.cleanedBody : "";
      const res = applyM4ReplyLint(state, cleanedBody);
      state = res.nextState;
      if (!res.correctedBody) return undefined;
      return { handled: true, reply: { text: res.correctedBody, body: res.correctedBody } };
    },
  };
}
