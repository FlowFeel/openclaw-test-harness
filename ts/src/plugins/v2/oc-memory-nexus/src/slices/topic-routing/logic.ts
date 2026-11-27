/**
 * Topic Routing & Flush Plan Resolver Pure Transition Algebra (Pillar 1).
 *
 * @invariants
 * - Pure logic: zero filesystem, network, or environment I/O (Axiom A1).
 * - Deterministic: outputs depend solely on inputs and injected clock (Axiom A2).
 * - Zero inline regexes: uses centralized patterns from shared/regex-library.js (Axiom A6).
 * - Non-repeating slugs: never emits `topic-<id>-topic-<id>` (Axiom A6 structural hygiene).
 *
 * @dft
 * - Tested via slices/topic-routing/tests/logic.spec.ts.
 */

import type {
  HookContext,
  MemoryCapabilityContext,
  MemoryFlushPlan,
} from "../../../../../shared/types.js";
import {
  TOPIC_CHAT_AND_THREAD_REGEX,
  PLATFORM_LANE_REGEX,
  USER_LANE_REGEX,
  slugNonAlphanumeric,
  slugEdgeHyphens,
} from "../../../../../shared/regex-library.js";

export const MEMORY_PROMPT_OBJECTIVES = {
  TOPIC: "Topic-specific decisions, corpus progress, open research hypotheses",
  PLATFORM: "Architecture specs, tooling migrations, infrastructure state",
  USER: "Personal preferences, collaboration principles, active agendas",
  FALLBACK: "General daily activity log (isolated legacy fallback)",
} as const;

export function parsePositiveTopicId(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function slugifyTopicName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const slug = normalized
    .replace(slugNonAlphanumeric(), "-")
    .replace(slugEdgeHyphens(), "");
  return slug || "unnamed-topic";
}

export function deriveTopicMemoryPath(
  topicId: number,
  topicSlugOrName?: string,
  basePrefix = "meta/memory/topics",
): { targetDir: string; targetPath: string; topicSlug: string } {
  const rawSlug = topicSlugOrName ? slugifyTopicName(topicSlugOrName) : "unnamed-topic";
  const redundant = new Set([
    "unnamed-topic",
    `topic-${topicId}`,
    String(topicId),
  ]);

  const topicSlug = redundant.has(rawSlug) ? "" : rawSlug;
  const dirName = topicSlug ? `${topicId}-${topicSlug}` : `${topicId}`;
  const targetDir = `${basePrefix}/${dirName}`;
  const targetPath = `${targetDir}/MEMORY.md`;

  return { targetDir, targetPath, topicSlug: topicSlug || "unnamed-topic" };
}

export function resolveMemoryFlushPlan(
  ctx?: MemoryCapabilityContext | HookContext,
  fallbackIsoDate: string | (() => string) = "1970-01-01",
): MemoryFlushPlan {
  const record = (ctx ?? {}) as Record<string, unknown>;
  const rawSessionKey =
    record.sessionKey ?? record.sessionId ?? record.conversationId;
  const sessionKey = typeof rawSessionKey === "string" ? rawSessionKey : "";

  // 1. Topic-Scoped Resolution (Pillar 1)
  const topicMatch = sessionKey.match(TOPIC_CHAT_AND_THREAD_REGEX as RegExp);
  const explicitTopicId = parsePositiveTopicId(
    record.topicId ?? record.threadId ?? topicMatch?.[2],
  );

  if (explicitTopicId) {
    const rawName =
      record.topicSlug ??
      record.topicName ??
      record.threadName ??
      record.name;
    const nameStr = typeof rawName === "string" ? rawName : undefined;
    const { targetPath, topicSlug } = deriveTopicMemoryPath(explicitTopicId, nameStr);

    return {
      targetPath,
      promptObjective: MEMORY_PROMPT_OBJECTIVES.TOPIC,
      sessionType: "topic",
      topicId: explicitTopicId,
      topicSlug,
    };
  }

  // 2. Platform / Monorepo Resolution
  const isPlatform =
    record.lane === "platform" ||
    record.sessionType === "platform" ||
    PLATFORM_LANE_REGEX.test(sessionKey);

  if (isPlatform) {
    return {
      targetPath: "meta/team/SPEC_LOG.md",
      promptObjective: MEMORY_PROMPT_OBJECTIVES.PLATFORM,
      sessionType: "platform",
    };
  }

  // 3. User Direct / Persona Resolution
  const userMatch = sessionKey.match(USER_LANE_REGEX as RegExp);
  const rawUser = record.user ?? record.userName ?? userMatch?.[1];
  if (typeof rawUser === "string" && rawUser.trim().length > 0) {
    const user = rawUser.trim();
    return {
      targetPath: `meta/memory/${user}/MEMORY.md`,
      promptObjective: MEMORY_PROMPT_OBJECTIVES.USER,
      sessionType: "user",
      user,
    };
  }

  // 4. Fallback Unscoped Resolution (isolated daily log)
  const dateStr =
    typeof fallbackIsoDate === "function" ? fallbackIsoDate() : fallbackIsoDate;
  return {
    targetPath: `memory/${dateStr}.md`,
    promptObjective: MEMORY_PROMPT_OBJECTIVES.FALLBACK,
    sessionType: "fallback",
  };
}
