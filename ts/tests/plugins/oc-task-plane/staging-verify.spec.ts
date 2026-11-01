import { describe, it, expect } from "vitest";
import {
  evaluateRevisionMatch,
  shasMatch,
  extractShaFromPayload,
  normalizeSha,
} from "../../../src/plugins/oc-task-plane/src/staging-verify-logic.js";
import { createTaskPlanePlugin } from "../../../src/plugins/oc-task-plane/src/index.js";

describe("T-587: Staging Revision Verification", () => {
  describe("pure logic comparator", () => {
    it("matches exact full and short SHAs", () => {
      const full = "3a4f891bce4567890abcdef1234567890abcdef1";
      const short = "3a4f891";
      expect(shasMatch(full, short)).toBe(true);
      expect(shasMatch(short, full)).toBe(true);
      expect(shasMatch("3A4F891", "3a4f891")).toBe(true);
    });

    it("rejects SHAs shorter than 7 chars or mismatched", () => {
      expect(shasMatch("123456", "123456")).toBe(false);
      expect(shasMatch("3a4f891", "8c21b0e")).toBe(false);
    });

    it("extracts SHA from various JSON payload structures", () => {
      expect(extractShaFromPayload({ commit: "3a4f891bce45678" })).toBe("3a4f891bce45678");
      expect(extractShaFromPayload({ sha: "8c21b0ea1" })).toBe("8c21b0ea1");
      expect(extractShaFromPayload({ gitSha: "abcdef1234" })).toBe("abcdef1234");
      expect(extractShaFromPayload("Deployed git commit: 3a4f891bce on Fri Nov 1")).toBe("3a4f891bce");
    });

    it("returns 'live' when served SHA matches expected SHA", () => {
      const payload = { commit: "8c21b0ea1234567890" };
      const verdict = evaluateRevisionMatch(payload, "8c21b0e");
      expect(verdict.verified).toBe(true);
      expect(verdict.status).toBe("live");
      expect(verdict.message).toContain("Staging deployment verified live");
    });

    it("returns 'stale_image_running' when served SHA differs from expected SHA", () => {
      const payload = { commit: "3a4f891bce4567890" };
      const verdict = evaluateRevisionMatch(payload, "8c21b0ea1");
      expect(verdict.verified).toBe(false);
      expect(verdict.status).toBe("stale_image_running");
      expect(verdict.message).toContain("Staging container is still running prior revision '3a4f891bce4567890'");
      expect(verdict.message).toContain("8c21b0ea1");
    });

    it("returns 'unparseable_revision' when payload contains no valid hash", () => {
      const payload = { error: "Site undergoing maintenance" };
      const verdict = evaluateRevisionMatch(payload, "8c21b0ea1");
      expect(verdict.verified).toBe(false);
      expect(verdict.status).toBe("unparseable_revision");
    });
  });

  describe("tool registration & I/O integration", () => {
    it("executes staging_verify tool with injected fetcher", async () => {
      let registeredTool: any = null;
      const mockApi: any = {
        registerTool: (tool: any) => {
          if (tool.name === "staging_verify") registeredTool = tool;
        },
        on: () => {},
        logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
      };

      const mockFetcher = async (url: string) => {
        if (url.includes("live")) {
          return { ok: true, status: 200, payload: { commit: "8c21b0ea" } };
        }
        if (url.includes("stale")) {
          return { ok: true, status: 200, payload: { commit: "3a4f891" } };
        }
        return { ok: false, status: 500, error: "Connection refused" };
      };

      const plugin = createTaskPlanePlugin({ fetchRevision: mockFetcher });
      plugin.register(mockApi);

      expect(registeredTool).not.toBeNull();

      // Case 1: live
      const resLive = await registeredTool.execute("call-1", {
        url: "https://staging.example/live",
        expectedSha: "8c21b0e",
      });
      const parsedLive = JSON.parse(resLive.content[0].text);
      expect(parsedLive.verified).toBe(true);
      expect(parsedLive.status).toBe("live");

      // Case 2: stale
      const resStale = await registeredTool.execute("call-2", {
        url: "https://staging.example/stale",
        expectedSha: "8c21b0e",
      });
      const parsedStale = JSON.parse(resStale.content[0].text);
      expect(parsedStale.verified).toBe(false);
      expect(parsedStale.status).toBe("stale_image_running");

      // Case 3: fetch failed
      const resErr = await registeredTool.execute("call-3", {
        url: "https://staging.example/down",
        expectedSha: "8c21b0e",
      });
      const parsedErr = JSON.parse(resErr.content[0].text);
      expect(parsedErr.verified).toBe(false);
      expect(parsedErr.status).toBe("fetch_failed");
    });
  });
});
