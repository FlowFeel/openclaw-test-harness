/**
 * Topic Provisioning Pure Logic — identity extraction, non-repeating slugification,
 * path derivation, and care-package skeleton assembly.
 *
 * @invariants
 * - Pure logic: zero filesystem or network I/O (Axiom 1).
 * - Deterministic outputs given inputs and injected clock (Axiom 2).
 * - Zero inline regexes (Axiom 6 structural hygiene): uses centralized regex patterns.
 * - Non-repeating workspace slugs: never emits `topic-<id>-topic-<id>`.
 *
 * @dft
 * - Tested via slices/topic-provisioning/tests/logic.spec.ts.
 */

import type { HookContext, HookEvent } from "../../../../../shared/types.js";
import { TOPIC_CHAT_AND_THREAD_REGEX } from "../../../../../shared/regex-library.js";
import {
  TOPIC_NON_ALPHANUMERIC_REGEX,
  TOPIC_LEADING_TRAILING_HYPHENS_REGEX,
  TELEGRAM_PREFIX_REGEX,
} from "../../utils.js";
import {
  renderCarePackageFrontmatter,
  renderCarePackageBody,
  renderOrientationSummary,
} from "./template.js";

export interface TopicOrientationParams {
  topicId: number;
  topicName: string;
  chatId: string;
  sessionKey: string | null;
  createdUtc: string;
  createdBy?: string;
  generatedBy?: string;
  workspaceRoot?: string;
}

export interface CarePackageSkeleton {
  frontmatter: string;
  markdown: string;
  summaryInjection: string;
  workspacePath: string;
  carePackageRelativePath: string;
}

export interface ExtractedTopicContext {
  topicId: number;
  topicName: string;
  chatId: string;
  sessionKey: string | null;
  createdBy: string;
  injectionKey: string;
}

export function parsePositiveTopicId(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Pure deterministic slugification for forum topic names.
 */
export function slugifyTopicName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const slug = normalized
    .replace(TOPIC_NON_ALPHANUMERIC_REGEX, "-")
    .replace(LEADING_TRAILING_HYPHENS_REGEX_REF, "");
  return slug || "unnamed-topic";
}

const LEADING_TRAILING_HYPHENS_REGEX_REF = TOPIC_LEADING_TRAILING_HYPHENS_REGEX;

/**
 * Derives the topic home workspace directory path without repeating `topic-<id>`.
 */
export function deriveTopicWorkspacePath(
  topicId: number,
  topicName: string,
  workspaceRoot = "/home/node/.openclaw/workspace",
): string {
  const slug = slugifyTopicName(topicName);
  const redundantSlugs = new Set([
    "unnamed-topic",
    `topic-${topicId}`,
    String(topicId),
  ]);
  if (redundantSlugs.has(slug)) {
    return `${workspaceRoot}/work/topic-${topicId}`;
  }
  return `${workspaceRoot}/work/topic-${topicId}-${slug}`;
}

export function sanitizeTelegramChatId(chatId: string): string {
  const match = chatId.match(TOPIC_CHAT_AND_THREAD_REGEX as RegExp);
  if (match && match[1]) {
    return match[1];
  }
  return chatId.replace(TELEGRAM_PREFIX_REGEX, "");
}

/**
 * Derives the care package relative and absolute archive paths.
 */
export function deriveCarePackagePath(
  chatId: string,
  topicId: number,
  workspaceRoot = "/home/node/.openclaw/workspace",
): { relativePath: string; absolutePath: string } {
  const sanitizedChatId = sanitizeTelegramChatId(chatId);
  const relativePath = `archive/sessions/telegram/${sanitizedChatId}/topics/${topicId}/care-package.md`;
  return {
    relativePath,
    absolutePath: `${workspaceRoot}/${relativePath}`,
  };
}

/**
 * Pure identity extractor from OpenClaw HookEvent + HookContext (with sessionKey fallback).
 */
export function extractTopicProvisioningContext(
  event: HookEvent,
  ctx?: HookContext,
): ExtractedTopicContext | null {
  const ctxRecord = ctx as Record<string, unknown> | undefined;
  const eventRecord = event as Record<string, unknown> | undefined;

  const rawSessionKey =
    ctx?.sessionKey ?? event?.sessionKey ?? ctxRecord?.sessionId ?? eventRecord?.sessionId;
  const sessionKeyStr = typeof rawSessionKey === "string" ? rawSessionKey : "";
  const sessionKeyMatch = sessionKeyStr.match(TOPIC_CHAT_AND_THREAD_REGEX as RegExp);

  const topicId = parsePositiveTopicId(
    ctx?.topicId ?? event?.topicId ?? ctxRecord?.threadId ?? eventRecord?.threadId ?? sessionKeyMatch?.[2],
  );
  if (!topicId) return null;

  const rawChatId = ctx?.chatId ?? event?.chatId ?? sessionKeyMatch?.[1];
  const chatId = String(rawChatId ?? "telegram:default");
  const topicName = String(ctx?.topicName ?? event?.topicName ?? `Topic ${topicId}`);

  const rawCreatedBy =
    ctxRecord?.sender ??
    ctxRecord?.senderName ??
    ctxRecord?.senderId ??
    ctxRecord?.createdBy ??
    eventRecord?.sender ??
    eventRecord?.senderName ??
    eventRecord?.senderId ??
    eventRecord?.createdBy;

  const injectionKey = String(
    ctx?.sessionId ?? ctx?.sessionKey ?? event?.sessionId ?? event?.sessionKey ?? `topic:${topicId}`,
  );

  return {
    topicId,
    topicName,
    chatId,
    sessionKey: sessionKeyStr.length > 0 ? sessionKeyStr : null,
    createdBy: rawCreatedBy ? String(rawCreatedBy) : "system",
    injectionKey,
  };
}

/**
 * Pure template assembler for the Turn 0 orientation care package skeleton.
 */
export function renderCarePackageSkeleton(params: TopicOrientationParams): CarePackageSkeleton {
  const workspacePath = deriveTopicWorkspacePath(params.topicId, params.topicName, params.workspaceRoot);
  const { relativePath } = deriveCarePackagePath(params.chatId, params.topicId, params.workspaceRoot);

  const templateInput = {
    topicId: params.topicId,
    topicName: params.topicName,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    createdUtc: params.createdUtc,
    createdBy: params.createdBy ?? "system",
    generatedBy: params.generatedBy ?? "flowfeel-oc-lane-supervisor@0.2.0",
    workspacePath,
    carePackageRelativePath: relativePath,
  };

  const frontmatter = renderCarePackageFrontmatter(templateInput);
  const markdown = `${frontmatter}\n\n${renderCarePackageBody(templateInput)}\n`;
  const summaryInjection = renderOrientationSummary(templateInput);

  return {
    frontmatter,
    markdown,
    summaryInjection,
    workspacePath,
    carePackageRelativePath: relativePath,
  };
}
