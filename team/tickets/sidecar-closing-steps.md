# Sidecar DFT Wiring — Closing Steps

> **Status:** PR #19 merged. M1 injection path wired. Morning of 2026-08-06.

## What's done

- ✅ Pure logic: `sidecar-router.ts` (shouldOffload, thresholds, rationale)
- ✅ Protocol: `sidecar-protocol.ts` (SidecarProtocol + NullSidecar)
- ✅ Registry: `sidecar-registry.ts` (cross-plugin singleton)
- ✅ Wiring: compaction-helper uses `sidecarWriter` with `await`
- ✅ oc-sidecar registers its client on `gateway_start`
- ✅ Phosphene review: H1 (await), H2 (statSync), M1 (registry), M2 (dead code) — all fixed
- ✅ CI green, merged to main
- ✅ 28 new tests (22 router + 6 registry)

## Closing steps (morning)

### 1. Pull, rebuild, reinstall, restart

```bash
cd work/flow/openclaw-test-harness
git checkout main && git pull
cd ts && npm run build:plugins
# Reinstall all plugins (sidecar-registry is bundled into each plugin by esbuild)
for p in src/plugins/oc-*/; do
  rm -rf ~/.openclaw/extensions/$(basename $p)
  openclaw plugins install "$p"
done
# Restart gateway
# Use gateway tool: restart
```

### 2. Verify sidecar injection is live

After restart, check the gateway logs for:
- `[oc-sidecar] Sidecar started on port 18900 (registered in sidecar-registry)`
- `[oc-compaction-helper] offloading serialize.session: ...` (when a large sessions.json write triggers)

Call `sidecar_health` — pool.completed should increment when compaction-helper offloads work.

### 3. Verify the offload path

```bash
# Check sidecar health
curl http://127.0.0.1:18900/health | python3 -m json.tool

# Trigger a compaction cleanup (send a message to force before_prompt_build)
# The sidecarWriter will check shouldOffload and route to sidecar if sessions.json > 100KB
```

### 4. Update AGENTS.md

Add the sidecar-registry to the Plugin Suite section:
- Cross-plugin registry: `shared/sidecar-registry.ts`
- oc-sidecar registers on gateway_start
- oc-compaction-helper reads from registry at hook time

### 5. Wire other plugins (follow-up)

The registry is available to all plugins. Next candidates for offloading:
- `oc-session-guard` — session cleanup writes (same pattern as compaction-helper)
- `oc-subagent-orchestrator` — queue serialization
- Any plugin doing JSON.stringify on large payloads

### 6. Document the DFT pattern

The sidecar wiring is the reference implementation for DFT-based CPU offloading:
```
Pure logic (decision) → Protocol (interface) → Registry (injection) → Wiring (plugin hook)
```
Document in `docs/dft-offload-pattern.md` for future plugin developers.

## Open questions for morning

- [ ] Should the sidecar cache stats be refreshed on a timer (not just after exec)?
- [ ] Should we add a `before_tool_call` hook for media-batcher (Gap 1)?
- [ ] Should the document-send-policy (Gap 2) be wired next?
