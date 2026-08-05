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
    python3 \
    && rm -rf /var/lib/apt/lists/*

# TypeScript runner (handles .js→.ts ESM resolution)
RUN npm install -g tsx

# OpenClaw — pinned, baked in. No runtime npm install.
ARG OC_VERSION=2026.6.8
RUN npm install -g openclaw@${OC_VERSION}

# Apply patches if any exist (no-op when none)
COPY ts/patches/ /patches/
RUN cd /usr/lib/nodejs22/lib/node_modules/openclaw 2>/dev/null && \
    for p in /patches/*.patch; do \
      [ -f "$p" ] && patch -p1 < "$p" || true; \
    done

WORKDIR /app
CMD ["sleep", "infinity"]
