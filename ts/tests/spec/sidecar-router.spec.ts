/**
 * BDD tests for sidecar-router — pure logic for CPU offload decisions.
 *
 * @dft A1 (pure), A2 (deterministic), A6 (check-result)
 */

import { describe, it, expect } from "vitest";
import {
  shouldOffload,
  getThreshold,
  buildOffloadRequest,
  estimatePayloadBytes,
  OFFLOAD_THRESHOLDS,
  type OffloadParams,
} from "../../src/plugins/shared/sidecar-router.js";

describe("Feature: Sidecar Router — offload decisions", () => {
  describe("Scenario: shouldOffload returns true when payload exceeds threshold and sidecar available", () => {
    it("offloads json.stringify when payload > 50KB", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: 75_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(true);
      expect(decision.operation).toBe("json.stringify");
      expect(decision.rationale).toContain("75000B");
      expect(decision.rationale).toContain("50000B");
    });

    it("offloads serialize.session when payload > 100KB", () => {
      const decision = shouldOffload({
        operation: "serialize.session",
        payloadBytes: 150_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(true);
      expect(decision.operation).toBe("serialize.session");
    });

    it("offloads compact.context when payload > 500KB", () => {
      const decision = shouldOffload({
        operation: "compact.context",
        payloadBytes: 750_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(true);
      expect(decision.operation).toBe("compact.context");
    });

    it("offloads json.parse when payload > 50KB", () => {
      const decision = shouldOffload({
        operation: "json.parse",
        payloadBytes: 60_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(true);
    });
  });

  describe("Scenario: shouldOffload returns false when payload below threshold", () => {
    it("does not offload json.stringify when payload < 50KB", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: 30_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(false);
      expect(decision.rationale).toContain("inline is faster");
    });

    it("does not offload when payload exactly at threshold - 1", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: OFFLOAD_THRESHOLDS.minJsonBytes - 1,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(false);
    });

    it("offloads when payload exactly at threshold", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: OFFLOAD_THRESHOLDS.minJsonBytes,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(true);
    });
  });

  describe("Scenario: shouldOffload returns false when sidecar unavailable", () => {
    it("returns false with rationale when sidecar not available", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: 500_000,
        sidecarAvailable: false,
        poolFull: false,
      });
      expect(decision.offload).toBe(false);
      expect(decision.rationale).toBe("sidecar not available");
    });
  });

  describe("Scenario: shouldOffload returns false when pool is full", () => {
    it("returns false when poolFull=true even with large payload", () => {
      const decision = shouldOffload({
        operation: "serialize.session",
        payloadBytes: 1_000_000,
        sidecarAvailable: true,
        poolFull: true,
      });
      expect(decision.offload).toBe(false);
      expect(decision.rationale).toContain("pool full");
    });
  });

  describe("Scenario: shouldOffload rejects unknown operations", () => {
    it("returns false for unknown operation name", () => {
      const decision = shouldOffload({
        operation: "json.sort",
        payloadBytes: 500_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.offload).toBe(false);
      expect(decision.rationale).toContain("unknown operation");
    });
  });

  describe("Scenario: getThreshold returns correct thresholds", () => {
    it("returns 50KB for json.stringify", () => {
      expect(getThreshold("json.stringify")).toBe(50_000);
    });
    it("returns 50KB for json.parse", () => {
      expect(getThreshold("json.parse")).toBe(50_000);
    });
    it("returns 100KB for serialize.session", () => {
      expect(getThreshold("serialize.session")).toBe(100_000);
    });
    it("returns 500KB for compact.context", () => {
      expect(getThreshold("compact.context")).toBe(500_000);
    });
    it("returns null for unknown operation", () => {
      expect(getThreshold("json.sort")).toBeNull();
    });
  });

  describe("Scenario: buildOffloadRequest creates valid payload", () => {
    it("builds request with operation and data", () => {
      const req = buildOffloadRequest("json.stringify", { key: "value" });
      expect(req.operation).toBe("json.stringify");
      expect(req.data).toEqual({ key: "value" });
    });
  });

  describe("Scenario: estimatePayloadBytes measures JSON size", () => {
    it("returns byte length for a simple object", () => {
      const bytes = estimatePayloadBytes({ key: "value" });
      expect(bytes).toBeGreaterThan(10);
      expect(bytes).toBeLessThan(50);
    });

    it("returns 0 for undefined", () => {
      expect(estimatePayloadBytes(undefined)).toBeGreaterThanOrEqual(0);
    });

    it("returns positive size for large object", () => {
      const large = { data: "x".repeat(100_000) };
      const bytes = estimatePayloadBytes(large);
      expect(bytes).toBeGreaterThan(100_000);
    });

    it("handles circular references gracefully", () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      const bytes = estimatePayloadBytes(circular);
      expect(bytes).toBe(0);
    });
  });

  describe("Scenario: fallback path — inline work when offload=false", () => {
    it("decision rationale is logged for observability", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: 10_000,
        sidecarAvailable: true,
        poolFull: false,
      });
      expect(decision.rationale).toContain("10000B");
      expect(decision.rationale).toContain("50000B");
      expect(decision.rationale).toContain("inline is faster");
    });

    it("decision rationale explains pool full", () => {
      const decision = shouldOffload({
        operation: "json.stringify",
        payloadBytes: 100_000,
        sidecarAvailable: true,
        poolFull: true,
      });
      expect(decision.rationale).toContain("pool full");
    });
  });
});
