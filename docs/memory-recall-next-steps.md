# Memory-recall delivery arms — thread resolutions & plugin build order

Resolves and amends the discussion in **#53** (`feat(memory-recall): delivery-arm hooks for indirect recall`). Source thread: Research Stable topic 90037, 2026-10-15 17:44–20:40 UTC. Full transcript: `2026-10-15-research-stable-transcript-signposts-thread.md` (dropped in-topic; to be committed alongside if wanted). Internal synthesis: phosphene/woodchipper `drafts/2026-10-15-itch-trigger-taxonomy-synthesis-v2.md` (Parts A–F).

```
!!! review-note
    This doc is the fold-in of the thread resolutions for review. Once approved, it becomes the build-order source of truth for the memory-recall plugin series and #53 gets a pointer comment.
```

## 1. Resolved decisions

### 1.1 Problem statement (amends framing)

The failure being solved: **models do not pull information they already have in memory.** Two classes, cut by *who steers*:

- **Direct** — user asks; cue present in context; model fails to act on the cue. Easier class: pointer descriptions fixed direct recall 0.81→0.94 on held-out scenarios (source-study E5).
- **Indirect** — model doing its own thinking/research; cue/signpost present; model walks past it. The troublesome class, and the bench's weakest region (9/14 kinds with no clear leader).

**Priority amendment:** self-directed-case arms (M6 marker, M1 event push, M8 stale wording) build before direct-case arms (M7 catalogue, M4 review gate, M5 resume refresh).

### 1.2 Standing weight set (owner: WaltonC, recorded before any estimate is read)

- **λfa = 0** — a needless pull is already priced once by λcost; double-counting chases perfection. FP retrievals of real-but-inapplicable notes are self-correcting (read, weighed, ignored).
- **λmis = 0.25 (residual-risk pricing)** — misapplication is managed by *representation*, not weights: notes carry scope conditions inline (`use when…`, `does not apply when…`, provenance, age, live-source pointer), so the model self-judges applicability at read time. Bench support: misapplication ran 0–4% even with bare notes (house styles 0/190, authority 8/191); the B9 refit showed v1's ~0.5 prior was itself the artifact that flipped two kinds' leaders.
- **λcost = 0.05 (unchanged).** Recall bias is the intended direction: under-retrieval is the expensive failure.
- **Hard constraint surviving: FP signposts ≠ FP retrievals.** A mis-aimed cue (wrong-item "changed" line, −0.227 vs the right one) occupies the signpost slot and suppresses the correct lookup — no inline context can fix a cue pointing elsewhere. Cue accuracy at write time stays a hard rule.
- task_ok is the guard for context-distraction effects, reported beside the utility, not inside a penalty term.

### 1.3 Note schema (foundation)

Every note carries frontmatter: `kind:` (14-kind catalogue), `use_when:`, `does_not_apply_when:`, `provenance:` (basis + age), `source:` (live-value pointer). One block, four consumers: applicability check at read time, M7 catalogue lines, K8 provenance surface, per-kind fire/hit/follow roll-up.

## 2. Build order

| # | Deliverable | Implements | Why this order |
|---|---|---|---|
| 0 | Note registry + frontmatter schema + migration pass over existing notes | foundation | everything downstream reads it; delivers the workspace (c) logging schema |
| 1 | Fire/hit/follow telemetry per kind per arm | P3, P4 | measurement backbone; unfired must be distinguishable from failed (18/28 push triggers never fired in the source grid) |
| 2 | Marker-on-file-read injection: `# may be out of date; the current version is kept in memory: <path>` | M6 | manager-honest, smallest surface, +0.10 [0.065, 0.136]; keys on the file itself |
| 3 | Compaction/resume wording standard: no confident current values in summaries; "changed since last summary" list on resume | M8 | rides the #33/#35 compaction series; 69% stale-copy rate is the strongest single datum |
| 4 | User-channel event push with hold-once / let-run variants | M1 | headline arm (+0.9 in-grid; sealed −0.56 discount recorded); biggest design surface |
| 5 | Tool-description note injection | M2 | cheap; runner-up for authority (0.346 vs 0.351) |
| 6 | Direct-case arms: catalogue, review gate pre-reply, resume refresh | M7, M4, M5 | easier class; build last per priority amendment |

**Trial discipline after each delivery:** one arm at a time per kind; predeclared adopt rule (follow-rate gain ≥ 0.10 over ≥ 20 sessions, no out-of-scope acting); expect ~0.10 winner's-curse shrinkage on picked arms; report effects with intervals across weight settings.

## 3. Open design questions (Ed)

1. **M1 channel semantics** — source result used a separate user-role message after the tool result. Can OC inject a user-role turn post-tool-call, or is systemEvent the only unattended channel? (Fallback recorded, carries the 0.14-vs-0.96 channel discount.)
2. **Hold-once state** — where does "held" live (per-session? persisted?) and what clears it: model ack, owner ack, or expiry?
3. **Registry source of truth** — frontmatter-in-place (notes travel with their own scope conditions; lean yes — it *is* the misapplication mechanism) vs a central registry (`registry.py` heartbeat precedent)?
4. **Hook surface** — does the current api.on set expose post-tool-call and pre-reply hooks? M1 and M4 hang off exactly those two.
5. **PR train** — does build step 3 ride the #33/#35 compaction provider series or go separate?

Answers to 1, 3, 4 unblock deliverables 0–2; the rest can trail.
