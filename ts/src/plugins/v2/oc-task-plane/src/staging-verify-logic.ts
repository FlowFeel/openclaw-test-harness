/**
 * Staging Revision Verification Logic (T-587)
 *
 * @behavior
 * Pure logic comparator for staging deployment revisions.
 * Compares served git commit SHAs against expected commit SHAs,
 * accounting for short vs full SHAs, prefixes, and metadata bodies.
 *
 * @dft
 * Pure functions only — no node:fs, no network, no process.
 */

import {
  quoteTrimGlobal,
  GIT_SHA_HEX_REGEX,
} from "../../../shared/regex-library.js";

export interface StagingVerifyOptions {
  ignoreCase?: boolean;
}

export type RevisionMatchStatus =
  | "live"
  | "stale_image_running"
  | "unparseable_revision"
  | "fetch_failed";

export interface StagingRevisionVerdict {
  verified: boolean;
  status: RevisionMatchStatus;
  servedSha?: string;
  expectedSha: string;
  message: string;
}

/**
 * Normalizes a git commit SHA string (trims, strips quotes/newlines).
 */
export function normalizeSha(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") return "";
  return raw.trim().replace(quoteTrimGlobal(), "").toLowerCase();
}

/**
 * Checks if two git SHAs match (prefix match allowed if at least 7 chars long).
 */
export function shasMatch(a: string, b: string): boolean {
  const normA = normalizeSha(a);
  const normB = normalizeSha(b);
  if (!normA || !normB) return false;
  if (normA.length < 7 || normB.length < 7) return false;
  if (normA === normB) return true;
  const minLen = Math.min(normA.length, normB.length);
  return normA.slice(0, minLen) === normB.slice(0, minLen);
}

/**
 * Extracts a candidate git commit SHA from various common HTTP response shapes:
 * - JSON body with fields like { commit, sha, gitSha, version, revision }
 * - HTTP header like X-Git-Commit or X-Revision
 * - Raw string
 */
export function extractShaFromPayload(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    // 40-char full hex or 7..12-char short hex
    const hexMatch = trimmed.match(GIT_SHA_HEX_REGEX as RegExp);
    if (hexMatch) return hexMatch[1];
    return null;
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["sha", "commit", "gitSha", "gitCommit", "revision", "version"]) {
      const val = obj[key];
      if (typeof val === "string") {
        const hex = val.match(GIT_SHA_HEX_REGEX as RegExp);
        if (hex) return hex[1];
      }
    }
  }

  return null;
}

/**
 * Pure evaluation of served vs expected revision.
 */
export function evaluateRevisionMatch(
  servedRaw: unknown,
  expectedSha: string,
  _options?: StagingVerifyOptions,
): StagingRevisionVerdict {
  const normExpected = normalizeSha(expectedSha);
  if (!normExpected || normExpected.length < 7) {
    return {
      verified: false,
      status: "unparseable_revision",
      expectedSha,
      message: `Invalid expectedSha '${expectedSha}'. Must be a valid git commit SHA (minimum 7 characters).`,
    };
  }

  const extracted = extractShaFromPayload(servedRaw);
  if (!extracted) {
    return {
      verified: false,
      status: "unparseable_revision",
      expectedSha,
      message: `Unable to extract a valid commit SHA from staging payload. Response did not contain a 7-40 character hexadecimal commit hash.`,
    };
  }

  const matched = shasMatch(extracted, normExpected);
  if (matched) {
    return {
      verified: true,
      status: "live",
      servedSha: extracted,
      expectedSha: normExpected,
      message: `Staging deployment verified live: served revision '${extracted}' matches expected SHA '${normExpected}'.`,
    };
  }

  return {
    verified: false,
    status: "stale_image_running",
    servedSha: extracted,
    expectedSha: normExpected,
    message: `Staging container is still running prior revision '${extracted}'. Container image rebuild or deployment cutover has not completed. Do not report feature as live until served revision matches expected SHA '${normExpected}'.`,
  };
}
