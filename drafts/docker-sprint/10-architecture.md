# Container Architecture

## One Image

```
docker/Dockerfile
├── FROM node:22-bookworm-slim
├── git, python3
├── tsx (TypeScript runner)
├── openclaw@2026.6.8 (pinned)
├── patches/ applied at build time
└── CMD sleep infinity (for testcontainers)
```

No source code baked in. Everything mounts at runtime.

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                   docker/Dockerfile                  │
│              (OC + tsx baked in)                     │
└──────────┬──────────────────────────┬───────────────┘
           │                          │
     ┌─────▼─────┐           ┌───────▼───────┐
     │  docker-  │           │ testcontainers│
     │  compose   │           │ (e2e tests)   │
     │  (CI)     │           │               │
     └─────┬─────┘           └───────┬───────┘
           │                          │
     ┌─────▼─────┐           ┌───────▼───────┐
     │ vitest    │           │ vitest e2e    │
     │ (in cont) │           │ (in cont)     │
     └───────────┘           └───────────────┘
```

## Volume Mounts

| Source (host) | Target (container) | Why |
|---------------|-------------------|-----|
| `ts/` | `/app/ts` | Plugin source, tests, configs |
| `oc-source/` | `/app/oc-source` | OC submodule for oc-source tests |
| `~/.npm` (named volume) | `/root/.npm` | npm cache (faster rebuilds) |

## CI Pipeline Layers

| Layer | Job | Docker? | Tests | When |
|-------|-----|---------|-------|------|
| 1 | Python Unit | No | 43 pytest | always |
| 2 | TypeScript Unit | No | 767 vitest (excl e2e) | always |
| 3 | Docker Integration | Yes (compose) | tsc + vitest in container | always |
| 4 | E2E Integration | Yes (testcontainers) | e2e + oc-source tests | always |
| 5 | Staging | No | worker-pool + adaptive | main only |

## When to use what

- **Local dev (no Docker):** `npx vitest run --config vitest.config.ci.ts` — 767 tests, fast
- **Local dev (with Docker):** `docker compose -f docker/docker-compose.test.yml up` — full suite in container
- **CI TS Unit:** same as local no-Docker
- **CI Docker Integration:** same as local with-Docker
- **CI E2E Integration:** testcontainers — each test builds its own container from the same Dockerfile

## Patches

Applied at image build time. See `ts/patches/README.md`.

| File | Type | What |
|------|------|------|
| child-admission.patch | Unified diff | Adds maxConcurrent + runTimeoutSeconds guards |
| child-admission.ts | Standalone | Full replacement (used by tests directly) |
| sqlite-accessor.ts | Standalone | SQLite registry with WAL |
| worker-pool.js | Standalone | worker_threads pool for CPU offload |
