# OpenClaw Test Container — one image, volume mounts for code.
#
# OC and tsx are baked in. Source code, patches, and test config
# come via volume mounts at runtime. No multi-stage, no source COPY.
#
# Build:  docker build -t oc-test ./docker
# Run:    docker run -v $(pwd)/ts:/app/ts oc-test
# CI:     docker compose -f docker/docker-compose.test.yml up

FROM node:22-bookworm-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    patch \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# TypeScript runner (handles .js→.ts ESM resolution)
RUN npm install -g tsx

# OpenClaw — pinned, baked in. No runtime npm install.
# NOTE: the npm tarball ships a trimmed src/ (no src/agents/*), so the patches
# in ts/patches/ CANNOT be applied to this tree — they target the full source
# in the oc-source submodule. Patch verification therefore happens at RUN time
# (see docker-compose.test.yml: `patch --dry-run` against /app/oc-source), not
# at build time.
ARG OC_VERSION=2026.6.8
RUN npm install -g openclaw@${OC_VERSION}

# Patch tooling is needed at RUN time for --dry-run verification against the
# mounted oc-source submodule (see docker-compose.test.yml command).
COPY ts/patches/ /patches/
RUN OC_ROOT="$(npm root -g)/openclaw" && \
    if [ ! -d "$OC_ROOT" ]; then \
      echo "FATAL: openclaw@${OC_VERSION} not found in npm global root" >&2; exit 1; \
    fi

WORKDIR /app
CMD ["sleep", "infinity"]
