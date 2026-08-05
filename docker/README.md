# Docker Test Container

One image. Volume mounts for code. No multi-stage.

## Build

```bash
docker build -t oc-test -f docker/Dockerfile .
```

## Run

```bash
# Interactive shell
docker run -v $(pwd)/ts:/app/ts -v $(pwd)/oc-source:/app/oc-source -it oc-test

# Run tests via docker compose
docker compose -f docker/docker-compose.test.yml up
```

## What's in the image

- node:22-bookworm-slim
- git, python3
- tsx (TypeScript runner with .js→.ts resolution)
- openclaw@2026.6.8 (pinned)
- Patches from ts/patches/ applied at build time

## What's NOT in the image

- Source code (mounted at runtime)
- Test files (mounted at runtime)
- oc-source submodule (mounted at runtime)

## CI

The CI pipeline has 3 layers:

1. **Unit** — Python + TypeScript unit/integration tests (no Docker)
2. **Docker Integration** — builds from Dockerfile, runs tsc + vitest in container
3. **E2E Integration** — testcontainers-based e2e tests (separate job)
4. **Staging** — runs on main only

## Troubleshooting

**"Failed to build image"** — Check that `ts/patches/` exists and `.dockerignore` doesn't exclude it.

**"Cannot find module"** — Make sure volume mounts include `ts/` and `oc-source/`.

**"tsx not found"** — The image has tsx installed globally. If running in a different container, install it: `npm install -g tsx`.

**Typecheck fails on oc-source** — Use `tsconfig.ci.json` which excludes `tests/oc-source/`.
