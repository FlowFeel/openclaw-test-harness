/**
 * BDD tests for sidecar-registry — cross-plugin sidecar sharing.
 *
 * @dft A5 (mock-doubles) — real in-process implementation, no mocks
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerSidecar,
  unregisterSidecar,
  getSidecar,
  resetSidecarRegistry,
} from "../../src/plugins/shared/sidecar-registry.js";
import { NullSidecar, type SidecarProtocol } from "../../src/plugins/shared/sidecar-protocol.js";

describe("Feature: Sidecar Registry — cross-plugin sharing", () => {
  beforeEach(() => resetSidecarRegistry());
  afterEach(() => resetSidecarRegistry());

  it("returns NullSidecar by default", () => {
    const sidecar = getSidecar();
    expect(sidecar).toBeInstanceOf(NullSidecar);
    expect(sidecar.isAvailable()).toBe(false);
  });

  it("returns registered sidecar after registerSidecar", () => {
    const mock: SidecarProtocol = {
      isAvailable: () => true,
      getStats: () => ({ active: 0, poolSize: 3, completed: 5, failed: 0 }),
      exec: async () => "result",
    };
    registerSidecar(mock);
    const sidecar = getSidecar();
    expect(sidecar).toBe(mock);
    expect(sidecar.isAvailable()).toBe(true);
  });

  it("returns NullSidecar after unregisterSidecar", () => {
    const mock: SidecarProtocol = {
      isAvailable: () => true,
      getStats: () => ({ active: 0, poolSize: 3, completed: 0, failed: 0 }),
      exec: async () => null,
    };
    registerSidecar(mock);
    expect(getSidecar().isAvailable()).toBe(true);
    unregisterSidecar();
    expect(getSidecar().isAvailable()).toBe(false);
  });

  it("replace previous registration with new one", () => {
    const first: SidecarProtocol = {
      isAvailable: () => true,
      getStats: () => ({ active: 1, poolSize: 3, completed: 0, failed: 0 }),
      exec: async () => null,
    };
    const second: SidecarProtocol = {
      isAvailable: () => true,
      getStats: () => ({ active: 2, poolSize: 4, completed: 0, failed: 0 }),
      exec: async () => null,
    };
    registerSidecar(first);
    registerSidecar(second);
    const sidecar = getSidecar();
    expect(sidecar).toBe(second);
    expect(sidecar.getStats().poolSize).toBe(4);
  });

  it("registry is a singleton — same instance across calls", () => {
    const mock: SidecarProtocol = {
      isAvailable: () => true,
      getStats: () => ({ active: 0, poolSize: 3, completed: 0, failed: 0 }),
      exec: async () => null,
    };
    registerSidecar(mock);
    expect(getSidecar()).toBe(getSidecar());
  });

  it("NullSidecar exec throws with clear message", async () => {
    const sidecar = getSidecar(); // NullSidecar
    expect(sidecar.isAvailable()).toBe(false);
    await expect(sidecar.exec("json.stringify", {})).rejects.toThrow("NullSidecar");
  });
});
