# OC Plugin Capability Map — Hooks, Telegram Surfaces, and Hard Limits

> **Audience:** us. This is the contract between our plugins and the OC runtime,
> derived from the pinned submodule (`oc-source/upstream` @ 2026.7.2, file paths
> cited). When OC bumps, re-verify the citations before trusting this doc.
>
> **Testing rule:** agents execute everything in GHA — never run the OC runtime
> locally (see `docs/testing-policy.md`).
>
> Purpose: (1) know every seam we can use, (2) know exactly where a plugin can
> hurt the gateway, (3) know what our harness proves vs. what is prose.

---

## 1. The hook surface — all 44 hook names

Source: `src/plugins/hook-types.ts` (`PluginHookName` union). Grouped by phase:

### Model / turn lifecycle
| Hook | Kind | Our use today |
|---|---|---|
| `before_model_resolve` | modifying | — |
| `agent_turn_prepare` | modifying | — |
| `before_prompt_build` | **modifying** (15s budget) | ✅ oc-compaction-helper (bloat strip) |
| `before_agent_reply` | modifying | — |
| `model_call_started` / `model_call_ended` | observation | — |
| `llm_input` / `llm_output` | observation | — |
| `before_agent_finalize` | modifying (15s) | — |
| `agent_end` | void (30s) | ✅ oc-compaction-helper |
| `before_agent_run` | modifying (15s, fail-closed) | — |

### Compaction
| Hook | Kind | Our use today |
|---|---|---|
| `before_compaction` | void (30s) | ✅ oc-compaction-helper |
| `after_compaction` | void (30s) | ✅ oc-compaction-helper |
| `before_reset` | void | — |

### Channel / messaging ← **the telegram-relevant group**
| Hook | Kind | Payload highlights (`src/plugins/hook-message.types.ts`) |
|---|---|---|
| `inbound_claim` | policy | first claim on an inbound message |
| `channel_pairing_requested` | void (2s) | pairing flow |
| `message_received` | void | `from`, `content`, **`threadId`**, **`sessionKey`**, `senderId`, `media[]` |
| `message_sending` | **modifying** (15s) | `to`, `content`, **`threadId`**; result may rewrite `content` or **`cancel`** with reason |
| `reply_payload_sending` | modifying (15s) | serialized reply payloads |
| `message_sent` | void | `to`, `content`, `success`, `messageId`, **`sessionKey`**, `error` |
| `before_message_write` | policy | transcript write gate |
| `before_dispatch` / `reply_dispatch` | policy / void | dispatch steering |

### Tool lifecycle
| Hook | Kind | Notes |
|---|---|---|
| `before_tool_call` | **modifying, fail-CLOSED** (15s) | a hung/throwing policy here DENIES the tool call |
| `after_tool_call` | observation | — |
| `tool_result_persist` | void | — |

### Session / subagent
| Hook | Kind | Our use today |
|---|---|---|
| `session_start` / `session_end` | void | ✅ oc-sidecar lifecycle |
| `subagent_spawning` | **deprecated** — do not use | — |
| `subagent_delivery_target` | modifying | — |
| `subagent_spawned` | void | ✅ oc-subagent-watchdog / orchestrator |
| `subagent_progress` | void | ✅ progress tracker |
| `subagent_ended` | void | ✅ watchdog |

### Gateway / platform
`gateway_start` (✅ used — sidecar spawn), `gateway_stop` (5s teardown budget),
`heartbeat_prompt_contribution`, `cron_reconciled`, `cron_changed`,
`skill_proposal_evaluate` (120s!), `skill_proposal_changed`, `skill_changed`,
`before_install` (fail-closed policy), `resolve_exec_env` (15s).

---

## 2. The plugin API surface (`OpenClawPluginApi`)

Source: `src/plugins/plugin-api.types.ts` + `api-builder.ts`. Beyond what we use:

| Capability | Status in our plugins |
|---|---|
| `registerTool` | ✅ all plugins |
| `registerHook` / `api.on` (typed) | ✅ lifecycle users |
| `registerChannel` | unused — we ride OC's telegram plugin, we don't replace it |
| `registerHttpRoute` | unused (sidecar exposes its own HTTP server) |
| `registerGatewayMethod` | unused — **candidate** for an RPC surface (e.g. `topic.audit` callable without an LLM turn) |
| `registerSessionCatalog` | **candidate**: read-only external-session catalog with "optional native adoption actions" — this is the *sanctioned* way to surface topics in OC's UI instead of our registry-sidecar approach |
| `registerService`, `registerCli`, `registerProvider`, `registerWorkerProvider`, facades (`session`, `agent`, `runContext`, `lifecycle`) | unused |

**Key discovery for topic management:** `registerSessionCatalog` is described as
"read-only external-session catalog with optional **native adoption actions**."
That may be the sanctioned path for topic *adoption* — worth a spike before we
build any registry-writing bypass.

---

## 3. Telegram-specific capabilities

### What the telegram plugin gives every agent
- **Topic session keys**: `agent:<agentId>:telegram:group:<chatId>:topic:<threadId>`
  — grammar pinned by our contract spec
  (`ts/tests/oc-source/topic-session-key-contract.spec.ts`) against
  `src/sessions/session-key-utils.ts` + `extensions/telegram/src/topic-conversation.ts`.
- **Thread routing on every message hook**: `message_received` / `message_sending` /
  `message_sent` all carry `threadId` — a plugin can observe/act per-topic without
  touching the registry.
- **Topic lifecycle actions** (`extensions/telegram/src/action-runtime.ts`,
  config-gated by `channels.telegram.actions.*`):
  - `createForumTopic` ✅ available
  - `editForumTopic` ✅ available (rename/close/reopen via Bot API)
  - No `deleteForumTopic` (Bot API has none — Telegram only supports close).
- **`threadBindings`** config: bindings can spawn sessions per topic
  (`spawnSessions`), with idle/max-age expiry — OC-native topic→session lifecycle.
- **`autoTopicLabel`**: OC renames DM forum topics via LLM natively.

### What that means for oc-topic-manager
Our recover plan (`action: "register"`) writes a *registry entry*. The Bot-API
lifecycle actions above are **agent tools / config-gated actions inside the
telegram plugin** — our plugin cannot call them directly; it can only (a) emit a
plan that the agent executes via its native actions, or (b) write the registry
itself (what `apply=true` does today). Both are legitimate; they answer different
questions (registry hygiene vs. forum hygiene).

### Limits we must respect
1. **No Bot API access from plugins by default** — the bot token lives in the
   telegram plugin's account config. If oc-topic-manager ever needs direct API
   access (e.g. `getForumTopicsByChat`), the sanctioned route is a config-provided
   token/account reference — *not* reaching into the telegram plugin.
2. **`message_count` is not last-activity.** The Bot API topic payload has no
   per-topic last-activity timestamp. `parse-topics.ts` therefore treats
   `lastActiveAt` as optional source-injected data; the archival idle rule
   reports "unknown" (never guesses) until a source derives it.
3. **Topic ids are stable, chat ids are signed.** Supergroup ids are negative
   (`-100…`); the grammar regex accepts `-?\d+` chat ids — our parsers must not
   coerce chat ids through `Number()` (precision loss beyond 2^53 is not an issue
   for Telegram ids today, but string-passthrough is the safer contract).

---

## 4. Hard limits — where a plugin can hurt the gateway

This is the crash-insurance section. OC loads plugins **in-process** (gateway
startup loader; only `registerWorkerProvider` opts into worker threads). So:

| # | Failure mode | OC's defense | Residual risk |
|---|---|---|---|
| 1 | `register()` / module load throws | none observed — boot fails | **ours to prevent** (boot smoke gate) |
| 2 | tool `execute` throws | unverified boundary catch | **ours to prevent** (never-throws fuzz) |
| 3 | hook handler hangs | per-hook timeouts: void 30s fail-open; modifying 15s fail-open w/ original; policy hooks (`before_tool_call`, `before_install`) fail-**closed** (denial); `gateway_stop` 5s | a 15–30s stall per event still degrades turns; sync CPU work blocks the loop with NO timeout defense |
| 4 | hook handler throws | runner swallows + logs (trace via `OPENCLAW_HOOK_DEBUG=1`) | silent behavior gaps — trace is our friend |
| 5 | sync CPU/fs on hot path | none — event loop is shared by all agents/channels | **ours to prevent** (loop-budget tests) |
| 6 | worker thread crash | piscina restarts; harness proves isolation | contained ✅ |
| 7 | sidecar crash | separate process, harness proves containment | contained ✅ |

**The two defenses we get for free:** hook timeouts (3) and throw-swallowing (4)
— with the caveat that `before_tool_call`/`before_install` fail *closed*, so a
buggy policy hook there doesn't just log, it *denies operations*.
**The two we get nothing for:** boot (1) and event-loop blocking (5).

### Diagnosing hooks in the wild
`OPENCLAW_HOOK_DEBUG=1` (already set in our test container) captures a structured
trace: `dispatch / no-handlers / error`, per-plugin `durationMs`, `swallowed` flags.
This is the first tool for any "plugin made OC weird" incident.

---

## 5. What our harness proves vs. what is prose

Standard: **full e2e against the real runtime — no ad hoc smoke tests.**
Where a real thing exists (real gateway, real `createHookRunner`, real registry
on disk, real telegram grammar), the test uses it (A5; T7 pattern in
efficiency-testing.md). Unit-level checks are permitted only for genuinely pure
logic; anything touching the runtime is proven through the e2e container
(testcontainers + patched OC, `tests/support/openclaw-container.ts`).

| Claim | Status |
|---|---|
| Plugin logic is pure/deterministic (A1/A2/A6) | ✅ machine-checked (foundry, CI + container) |
| Tool manifests match registered tools (A3) | ✅ machine-checked |
| Recovery plans conform to OC's key grammar | ✅ machine-checked (`topic-session-key-contract.spec.ts`, real OC parsers) |
| Registry write is idempotent, never overwrites | ✅ machine-checked against a real registry file |
| Container parity (typecheck + foundry + build + tests in image) | ✅ GHA job = local compose |
| Tools never throw through the REAL tool boundary, hostile inputs included | ⚠️ e2e gate to build — fire tools through the running gateway, not a mock API |
| Every plugin boots in a REAL gateway (discovery + `register()` + listener) | ✅ machine-checked (`tests/e2e/plugin-boot-gate.spec.ts`: all plugins boot together, HTTP healthy) |
| Hostile plugin config / broken load paths fail the boot LOUDLY (fail-closed) | ✅ machine-checked (same spec — OC enforces manifest configSchema at boot; pinned) |
| Hooks don't stall the event loop under REAL dispatch | ⚠️ e2e gate to build — T7 pattern with real `createHookRunner`, loop probe attached |
| Registry writes are crash-safe (atomic + backup) | ⚠️ not yet — `writeRecoveryPlan` writes in place |
| Hook trace observability (`OPENCLAW_HOOK_DEBUG=1`) | ✅ enabled in the test container |

## 6. The e2e gate plan (replaces smoke proposals)

All three gates run inside the existing container e2e layer
(`tests/e2e/`, real OC via testcontainers), never as standalone smoke scripts:

1. **Boot gate** — ✅ DONE (`tests/e2e/plugin-boot-gate.spec.ts`, real
   `openclaw gateway run` in the container). Pinned findings: all plugins boot
   together and serve HTTP; OC **fails closed** on hostile plugin config
   (manifest configSchema enforced at boot, stability bundle written) and on
   broken load paths — both pinned as loud, named failures, never silent
   degradation. Workspace-origin plugins need explicit
   `plugins.entries.<id>.enabled: true` (discovered empirically).
2. **Tool-boundary gate** — next: enumerate tools registered in the running
   gateway and fire each through the real tool surface with hostile inputs
   (null, wrong types, huge strings, circular refs, throwing getters). Assert:
   a response comes back through the boundary, the gateway survives, and the
   hook trace shows no swallowed boot-time errors.
3. **Loop-budget gate** — real `createHookRunner` (T7, `efficiency-testing.md`
   H7) with the event-loop probe: dispatch latency bounds asserted with 0/1/10
   handlers, and each of our hook handlers exercised with representative
   payloads under the probe with a stall budget.

Plus the registry write-path hardening (atomic write + backup before persist),
e2e-proven against the running gateway's live sessions.json.

## 7. Open questions / spikes worth running

1. `registerSessionCatalog` adoption actions — can topic registry state be
   surfaced natively (and can adoption write back)? Spike before building more
   registry-side machinery.
2. Does the tool-execute boundary catch plugin tool throws? One empirical test
   in the container answers it; decides how paranoid the fuzz gate must be.
3. Can oc-topic-manager request the telegram account reference (read-only) via
   config to call `getForumTopicsByChat` itself — closing the last injected
   input (topic payloads) in the audit loop?
