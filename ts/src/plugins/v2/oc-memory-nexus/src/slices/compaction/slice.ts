/**
 * Compaction Slice Adapter — wires REAL compact_check, compact_delta, sanitize_transcript,
 * and before_compaction through injectable I/O Protocols (zero stubs).
 *
 * @invariants
 * - All filesystem access mediated via injectable Protocols (SessionsReader, PathMtimeReader,
 *   TranscriptReader/Writer) for Axiom A1/A5 compliance.
 *
 * @dft
 * - Tested via oc-memory-nexus integration & manifest specs with InMemory* doubles.
 */

import {
  Type,
  type PluginApi,
  type HookEvent,
  type HookContext,
} from "../../../../../shared/types.js";
import { readSessions, getSessionFileSize } from "../../sessions-io.js";
import { readPathMtimes, type PathMtimeReader } from "../../resume-delta-io.js";
import {
  readTranscriptLines,
  writeTranscriptLines,
  resolveSessionTranscriptPath,
} from "../../transcript-sanitizer-io.js";
import type { SessionsMap } from "../../../../../shared/session-cleanup.js";
import {
  createCompactionSliceState,
  type CompactionSliceConfig,
  type MemoryDistillTaskSpec,
} from "./state.js";
import {
  evaluateCompactionCheck,
  recordCompactionCheckpoint,
  evaluateResumeDelta,
  runTranscriptSanitization,
  buildMemoryDistillTaskSpec,
  recordDistillationTask,
} from "./logic.js";
import { resolveMemoryFlushPlan } from "../topic-routing/logic.js";

export interface CompactionIoDeps {
  sessionsPath?: string;
  sessionsReader?: (path?: string) => SessionsMap | null;
  sessionSizeReader?: (path?: string) => number;
  mtimeReader?: PathMtimeReader;
  transcriptPathResolver?: (sessionKey: string) => string | null;
  transcriptReader?: (filePath: string) => string[] | null;
  transcriptWriter?: (filePath: string, lines: string[]) => boolean;
  clock?: () => number;
  durableSpawner?: (spec: MemoryDistillTaskSpec) => Promise<{ taskId?: string; ok: boolean } | unknown> | unknown;
}

export interface CompactionSliceHandle {
  onBeforeCompaction: (event?: HookEvent, ctx?: HookContext) => Promise<MemoryDistillTaskSpec | null>;
  getLastDistillationTask: () => MemoryDistillTaskSpec | null;
}

export function bindCompactionSlice(
  api: PluginApi,
  config: CompactionSliceConfig,
  deps: CompactionIoDeps = {},
): CompactionSliceHandle {
  let state = createCompactionSliceState();
  const sessionsPath = deps.sessionsPath;
  const sessionsReader = deps.sessionsReader ?? readSessions;
  const sizeReader = deps.sessionSizeReader ?? getSessionFileSize;
  const mtimeReader = deps.mtimeReader ?? readPathMtimes;
  const resolvePath = deps.transcriptPathResolver ?? resolveSessionTranscriptPath;
  const readLines = deps.transcriptReader ?? readTranscriptLines;
  const writeLines = deps.transcriptWriter ?? writeTranscriptLines;
  const clock = deps.clock ?? (() => Date.now());

  api.registerTool({
    name: "compact_check",
    description:
      "Check transcript size estimate and get compaction recommendation based on live session size and cooldown state.",
    parameters: Type.Object({}),
    async execute() {
      const sessions = sessionsReader(sessionsPath);
      const sizeBytes = sessions ? JSON.stringify(sessions).length : sizeReader(sessionsPath);
      const { nextState, decision } = evaluateCompactionCheck(state, config, sizeBytes, clock());
      state = nextState;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                ...decision,
                entryCount: sessions ? Object.keys(sessions).length : 0,
                recommendation: decision.shouldTrigger ? "compact" : "healthy",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  api.registerTool({
    name: "compact_delta",
    description:
      "Query file and state modifications detected since the last compaction checkpoint (M8).",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to inspect" })),
    }),
    async execute(_id, params) {
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : config.watchedPaths;
      const currentFiles = mtimeReader(paths);
      const { nextState, report } = evaluateResumeDelta(state, currentFiles, clock());
      state = nextState;
      const deltaCount = report.modified.length + report.added.length + report.removed.length;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                checkpoint: report.checkpointId,
                deltaCount,
                modified: report.modified,
                added: report.added,
                removed: report.removed,
                hasChanges: report.hasChanges,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  api.registerTool({
    name: "sanitize_transcript",
    description:
      "In-situ transcript sanitizer — inspects a topic transcript (.jsonl), collapses zero-delta poll spam, deduplicates repeated errors, and applies head/tail elision idempotently.",
    parameters: Type.Object({
      sessionKey: Type.Optional(Type.String({ description: "Session key or UUID of the topic transcript" })),
      dryRun: Type.Optional(Type.Boolean({ description: "If true, simulates sanitization without modifying file" })),
    }),
    async execute(_id, params) {
      const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "current";
      const dryRun = params.dryRun === true;
      const filePath = resolvePath(sessionKey);
      const rawLines = filePath ? readLines(filePath) : null;

      if (!filePath || !rawLines) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, sessionKey, dryRun, error: "Transcript not found" }, null, 2),
            },
          ],
        };
      }

      const { nextState, outputLines, report, mutated, linesRemoved, bytesSaved } =
        runTranscriptSanitization(state, rawLines, dryRun);
      state = nextState;
      const written = !dryRun && mutated ? writeLines(filePath, outputLines) : false;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                sessionKey,
                dryRun,
                sanitized: mutated,
                written,
                linesExamined: report.originalEntries,
                linesRemoved,
                bytesSaved,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  return {
    async onBeforeCompaction(event?: HookEvent, ctx?: HookContext) {
      const currentFiles = mtimeReader(config.watchedPaths);
      const res = recordCompactionCheckpoint(state, currentFiles, clock());
      state = res.nextState;
      api.logger?.info?.(`[oc-memory-nexus] pre-compaction checkpoint recorded: ${res.checkpointId}`);

      const record = (ctx ?? event ?? {}) as Record<string, unknown>;
      const rawSessionKey =
        record.sessionKey ?? record.sessionId ?? record.conversationId;
      const sessionKey = typeof rawSessionKey === "string" ? rawSessionKey : "";

      if (!sessionKey) {
        return null;
      }

      const plan = resolveMemoryFlushPlan(ctx ?? event, () => new Date(clock()).toISOString().slice(0, 10));
      const targetDir = plan.targetPath.includes("/")
        ? plan.targetPath.slice(0, plan.targetPath.lastIndexOf("/"))
        : plan.targetPath;

      const filePath = resolvePath(sessionKey);
      const lines = filePath ? readLines(filePath) : null;
      const transcriptTail =
        lines && lines.length > 0 ? lines.slice(-20).join("\n") : undefined;

      const taskSpec = buildMemoryDistillTaskSpec({
        sessionKey,
        targetDir,
        targetFile: plan.targetPath,
        topicId: plan.topicId,
        transcriptTail,
      });

      state = recordDistillationTask(state, taskSpec);

      if (typeof deps.durableSpawner === "function") {
        await deps.durableSpawner(taskSpec);
      } else if (
        typeof (api as unknown as Record<string, unknown>).executeTool === "function" &&
        ((api as unknown as Record<string, unknown>).tools as Map<string, unknown> | undefined)?.has?.("durable_spawn")
      ) {
        await ((api as unknown as Record<string, unknown>).executeTool as (name: string, params: unknown) => Promise<unknown>)(
          "durable_spawn",
          taskSpec,
        );
      }

      api.logger?.info?.(`[oc-memory-nexus] emitted off-loop durable distillation task for ${sessionKey}`);
      return taskSpec;
    },
    getLastDistillationTask() {
      return state.lastDistillationTask;
    },
  };
}
