# oc-topic-worker-pool: Hook-Based Worker Pool for Telegram Topics

A foundry-scaffolded OC plugin that implements concurrency control for Telegram forum topic sessions via six hooks. The core idea: **the `await` in `before_agent_run` IS the queue.**

---

## The problem

OC has no built-in concurrency control for agent runs. Each Telegram forum topic is its own session (`{chatId}:topic:{topicId}`), and all sessions process independently and concurrently. If 20 topics message at once, 20 LLM calls fire simultaneously with no backpressure.

The gateway's `gateway-work-admission.ts` handles restart/drain/suspend — not LLM call concurrency. There's no semaphore, no queue, no pool.

## The solution

A hook-based worker pool using a counting semaphore:

```
before_agent_run  →  await semaphore.acquire()    (blocks if pool full = backpressure)
      ↓
  [AGENT RUNS — LLM call]
      ↓
agent_end          →  semaphore.release()          (frees slot, resolves next waiter)
```

The semaphore acquire/release pair spans the entire LLM call. When the pool is full, `acquire()` returns `{action:"queued"}` and the `AsyncSemaphore` wrapper creates a Promise that resolves when `release()` hands off a freed slot. The hook handler `await`s this Promise — OC's hook system awaits the hook — the message processing pauses until a slot frees.

**No rejected messages, just queued.**

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Pure logic (topic-worker-pool-logic.ts) — 31 specs              │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Semaphore    │  │ Topic Router │  │ Dedup/Dispatch       │   │
│  │ create()     │  │ parseKey()   │  │ buildDedupKey()      │   │
│  │ acquire()    │  │ routeTopic() │  │ decideDispatch()     │   │
│  │ release()    │  │              │  │ hashContent()        │   │
│  │ getStats()   │  │              │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────────┘   │
└─────────┼─────────────────┼───────────────────┼──────────────────┘
          │                 │                   │
┌─────────┼─────────────────┼───────────────────┼──────────────────┐
│  Wiring (index.ts) — AsyncSemaphore + hooks   │                  │
│         │                 │                   │                  │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌────────▼─────────────┐    │
│  │ Main Pool   │  │ Sub Pool    │  │ Dedup Cache           │    │
│  │ (semaphore) │  │ (semaphore) │  │ (Map<key, timestamp>) │    │
│  └──────┬──────┘  └──────┬──────┘  └────────┬─────────────┘    │
└─────────┼────────────────┼───────────────────┼──────────────────┘
          │                │                   │
          ▼                ▼                   ▼
   before_agent_run   subagent_spawning   before_dispatch
   (acquire main)     (acquire sub)       (route + dedup)
          │                │
          ▼                ▼
      agent_end        subagent_ended
   (release main)     (release sub)
```

### Pure logic seam (`topic-worker-pool-logic.ts`)

Three pure modules in one file:

#### 1. Semaphore

```typescript
interface SemaphoreState {
  readonly max: number;
  active: number;
  totalAcquired: number;
  totalReleased: number;
  totalWaited: number;    // backpressure events
  peakActive: number;
}

function createSemaphore(max: number): SemaphoreState
function acquire(state: SemaphoreState): SemaphoreReport   // {action:"acquired"|"queued"}
function release(state: SemaphoreState): SemaphoreReport   // {action:"released"|"rejected"}
function getStats(state: SemaphoreState): { ... }
function isFull(state: SemaphoreState): boolean
function hasCapacity(state: SemaphoreState): boolean
```

The pure `acquire()` only updates counters — it doesn't block. The wiring layer (`AsyncSemaphore`) adds the Promise/resolve plumbing that makes `acquire()` actually `await` when full.

#### 2. Topic router

```typescript
function parseTopicSessionKey(sessionKey: string): ParsedTopicSession | null
function routeTopic(topic: ParsedTopicSession | null, config: TopicRoutingConfig): RoutingDecision
```

Parses Telegram forum topic session keys (`{chatId}:topic:{topicId}`) and routes them to pools based on priority rules:

1. **Priority topic** — specific topic → dedicated pool
2. **Per-chat** — all topics in a chat → dedicated pool
3. **Default** — everything else

#### 3. Dedup + dispatch

```typescript
function buildDedupKey(topic: ParsedTopicSession | null, contentHash: string): DedupKey
function decideDispatch(params: { topic, content, isDuplicate, pool }): DispatchRouteReport
function hashContent(content: string): string  // pure DJB2 hash
```

Builds dedup keys for short-circuiting duplicate messages within a time window, and decides whether to `route`, `short-circuit`, or `skip`.

### Wiring layer (`index.ts`)

#### AsyncSemaphore

The impure wrapper around the pure `SemaphoreState`:

```typescript
interface AsyncSemaphore {
  state: SemaphoreState;
  waiters: Array<{ resolve: () => void; waiterId: number }>;
  acquire(): Promise<SemaphoreReport>;  // awaits when full
  release(): SemaphoreReport;           // resolves next waiter
}
```

When `acquire()` returns `{action:"queued"}`, the wrapper creates a Promise and pushes its resolver onto `waiters`. When `release()` frees a slot, it shifts the next waiter, re-acquires on its behalf, and resolves the Promise.

#### The six hooks

| Hook | Type | Role | What it does |
|------|------|------|-------------|
| `before_dispatch` | — | Ingress router | Parse `sessionKey`, route by topic, dedup within window, short-circuit duplicates |
| `before_agent_run` | modifying (fail-closed) | **Admission gate** | `await mainPool.acquire()` — the await IS the queue. Returns `{outcome:"pass"}` |
| `agent_end` | void | **Slot release** | `mainPool.release()` — frees slot, resolves next waiter |
| `subagent_spawning` | modifying | Sub-pool dispatch | `await subPool.acquire()` — separate pool prevents starvation |
| `subagent_ended` | void | Sub-slot release | `subPool.release()` |
| `before_agent_reply` | claiming | Egress observation | Logs pool stats (future: per-topic rate limiting, reply merging) |

---

## Key design decisions

### `await`, not `block`, for backpressure

`before_agent_run` can return `{outcome:"pass"}` or `{outcome:"block", reason}`. `block` rejects the message with a user-facing error. That's for hard limits (quotas, rate limits). For backpressure, the hook handler **`await`s the semaphore acquire** — the hook doesn't return until a slot is available. OC's hook system awaits the hook. The message processing pauses. No rejection, just a queue.

### Two pools (main + sub)

Subagents get their own pool. Without this, 20 subagents spawned from a single topic could consume all main pool slots, starving other topics' main agent runs. The sub-pool is sized independently (default: 2 vs main's 3).

### `before_dispatch` short-circuit is the cheapest path

For duplicate messages or empty content, `before_dispatch` returns `{handled:true, text}` and the agent is never called. Zero pool pressure, zero LLM cost. The dedup window (default: 5s) prevents reprocessing the same message within a topic.

### Topic affinity via `sessionKey`

`before_dispatch` sees `sessionKey` which contains `{chatId}:topic:{topicId}`. The routing config can assign:
- High-priority topics to a dedicated pool slice
- An entire chat's topics to a dedicated pool
- Everything else to the default pool

### Module-scope state

The semaphore state is created once in `register()` and shared across all hook invocations via closure. All topics in all chats share one main pool and one sub pool. This is intentional — the pool is a global resource, not per-topic.

---

## Configuration

```json
{
  "mainPoolMax": 3,
  "subPoolMax": 2,
  "dedupWindowMs": 5000,
  "routing": {
    "defaultPool": "main",
    "priorityTopics": [
      { "topicId": "42", "pool": "priority" }
    ],
    "chatPools": [
      { "chatId": "-100456789", "pool": "chat100" }
    ]
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `mainPoolMax` | 3 | Max concurrent main agent runs |
| `subPoolMax` | 2 | Max concurrent subagent runs |
| `dedupWindowMs` | 5000 | Dedup window in ms (same topic + content) |
| `routing.defaultPool` | "main" | Pool for topics that don't match any rule |
| `routing.priorityTopics` | — | Specific topic → dedicated pool |
| `routing.chatPools` | — | All topics in a chat → dedicated pool |

---

## Test coverage

| Test file | Specs | What |
|-----------|-------|------|
| `tests/topic-worker-pool-logic.spec.ts` | 31 | Semaphore lifecycle, topic parsing, routing precedence, dedup keys, dispatch decisions, content hashing |
| `tests/integration.spec.ts` | 2 | Hook registration (6 hooks), initialization logging |
| `tests/manifest.spec.ts` | — | Manifest validation (foundry-generated) |
| **Total** | **33** | All pass, foundry validator: all six DFT axioms pass |

### Semaphore test highlights

- **Acquire up to max** — slots fill, `active` increments, `peakActive` tracks
- **Queue when full** — `acquire()` returns `{action:"queued", waiterId}`, `active` stays the same, `totalWaited` increments
- **Release** — `active` decrements, `totalReleased` increments
- **Double-release guard** — `release()` with `active=0` returns `{action:"rejected"}`
- **Peak tracking** — `peakActive` never decreases (monotonic max)
- **Full cycle** — acquire×2, queue, release, re-acquire (simulates waiter handoff)

### Topic routing test highlights

- **Parse** — standard keys (`telegram:123:-100:topic:42`), bare keys (`-100:topic:42`), non-topic (`telegram:123:456` → null)
- **Route precedence** — priority > chat > default
- **Non-topic** — routes to default pool with `isNonTopic: true`
