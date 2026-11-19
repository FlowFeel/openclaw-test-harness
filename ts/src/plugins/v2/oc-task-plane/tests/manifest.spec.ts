/**
 * Tier 2 Manifest Spec: oc-task-plane bidirectional contract conformance.
 *
 * @dft Verifies openclaw.plugin.json tools and hooks match registered plugin surface.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pluginDef from "../src/index.js";
import { InMemoryPluginApi } from "../../../../../tests/doubles/in-memory-plugin-api.js";

describe("oc-task-plane (Tier 2 Manifest)", () => {
  it("conforms bidirectionally with openclaw.plugin.json tools and hooks", () => {
    const manifestPath = resolve(__dirname, "../openclaw.plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    expect(manifest.contracts.tools.sort()).toEqual(api.registeredToolNames());
    expect(manifest.contracts.hooks.sort()).toEqual(api.registeredHookNames());
  });
});

