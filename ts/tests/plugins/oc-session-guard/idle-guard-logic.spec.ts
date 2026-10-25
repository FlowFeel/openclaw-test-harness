/**
 * Idle guard admission logic unit tests.
 *
 * Verifies that automated idle heartbeats and empty prompts are blocked before
 * reaching the model, while active user prompts and actionable periodic tasks
 * are admitted without interference.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateAgentRunAdmission,
  hasActionableWork,
  matchesIdleHeartbeatSignature,
} from "../../../src/plugins/oc-session-guard/src/idle-guard-logic.js";
import { MESSAGES } from "../../../src/plugins/oc-session-guard/src/utils.js";

describe("idle-guard-logic: evaluateAgentRunAdmission", () => {
  describe("interactive user turns", () => {
    it("admits ordinary conversational user prompts", () => {
      const decision = evaluateAgentRunAdmission("Hello, what is the status of the build?");
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("admits programming and analysis requests", () => {
      const decision = evaluateAgentRunAdmission("Refactor the worker pool to eliminate deadlocks");
      expect(decision).toEqual({ outcome: "pass" });
    });
  });

  describe("empty or whitespace turns", () => {
    it("blocks undefined prompt", () => {
      const decision = evaluateAgentRunAdmission(undefined);
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_PROMPT_BLOCKED_REASON,
      });
    });

    it("blocks empty prompt", () => {
      const decision = evaluateAgentRunAdmission("");
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_PROMPT_BLOCKED_REASON,
      });
    });

    it("blocks whitespace-only prompt", () => {
      const decision = evaluateAgentRunAdmission("   \n\t  ");
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_PROMPT_BLOCKED_REASON,
      });
    });
  });

  describe("automated idle heartbeat turns", () => {
    it("blocks standard default OpenClaw heartbeat prompt", () => {
      const prompt =
        "Follow the heartbeat monitor scratch context when provided. " +
        "Recurring tasks are automations; create or change their schedules with the automations tool, " +
        "not heartbeat scratch. Do not infer or repeat old tasks from prior chats. " +
        "If nothing needs attention, reply HEARTBEAT_OK.";

      expect(matchesIdleHeartbeatSignature(prompt)).toBe(true);
      expect(hasActionableWork(prompt)).toBe(false);

      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });

    it("blocks structured heartbeat_respond tool prompt when idle", () => {
      const prompt =
        "Follow the heartbeat monitor scratch context when provided. " +
        "Recurring tasks are automations; create or change their schedules with the automations tool, " +
        "not heartbeat scratch. Do not infer or repeat old tasks from prior chats. " +
        "Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention.";

      expect(matchesIdleHeartbeatSignature(prompt)).toBe(true);
      expect(hasActionableWork(prompt)).toBe(false);

      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });

    it("blocks OpenClaw heartbeat transcript poll prompt", () => {
      const prompt = "[OpenClaw heartbeat poll]";
      expect(matchesIdleHeartbeatSignature(prompt)).toBe(true);

      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });

    it("blocks turn with heartbeat trigger context when no tasks exist", () => {
      const decision = evaluateAgentRunAdmission("Check status", { trigger: "heartbeat" });
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });

    it("blocks turn with isHeartbeat: true when no tasks exist", () => {
      const decision = evaluateAgentRunAdmission("Routine check", { isHeartbeat: true });
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });
  });

  describe("actionable heartbeat turns (allowed to run)", () => {
    it("admits heartbeat with scheduled periodic tasks", () => {
      const prompt =
        "Run the following periodic tasks (only those due based on their intervals):\n" +
        "- db-backup: backup database to s3\n" +
        "After completing all due tasks, reply HEARTBEAT_OK.";

      expect(hasActionableWork(prompt)).toBe(true);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("admits heartbeat with due commitments", () => {
      const prompt =
        "Follow the heartbeat monitor scratch context when provided.\n\n" +
        "Due inferred follow-up commitments are available for this exact agent and channel scope.\n" +
        "Commitments: [{\"reason\": \"check customer reply\"}]";

      expect(hasActionableWork(prompt)).toBe(true);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("admits heartbeat with background exec completion event", () => {
      const prompt =
        "Background task completed: pid 4321 exited with code 0.\n" +
        "Follow the heartbeat monitor scratch context when provided. If nothing needs attention, reply HEARTBEAT_OK.";

      expect(hasActionableWork(prompt)).toBe(true);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("admits heartbeat with cron system event", () => {
      const prompt =
        "Scheduled job cron:nightly-sync triggered.\n" +
        "Follow the heartbeat monitor scratch context when provided.";

      expect(hasActionableWork(prompt)).toBe(true);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("admits heartbeat with non-empty scratch directives", () => {
      const prompt =
        "Follow the heartbeat monitor scratch context when provided. If nothing needs attention, reply HEARTBEAT_OK.\n\n" +
        "Heartbeat monitor scratch:\nCheck disk space and prune docker logs.";

      expect(hasActionableWork(prompt)).toBe(true);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({ outcome: "pass" });
    });

    it("blocks heartbeat when scratch directive section is empty whitespace", () => {
      const prompt =
        "Follow the heartbeat monitor scratch context when provided. If nothing needs attention, reply HEARTBEAT_OK.\n\n" +
        "Heartbeat monitor scratch:\n   ";

      expect(hasActionableWork(prompt)).toBe(false);
      const decision = evaluateAgentRunAdmission(prompt);
      expect(decision).toEqual({
        outcome: "block",
        reason: MESSAGES.IDLE_HEARTBEAT_BLOCKED_REASON,
      });
    });
  });
});
