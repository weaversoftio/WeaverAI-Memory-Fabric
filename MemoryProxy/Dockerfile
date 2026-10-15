# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# WeaverAI Memory Fabric-Agent-Memory · MemoryProxy — Production Image
# ──────────────────────────────────────────────────────────────────────
# Multi-stage build (requires DOCKER_BUILDKIT=1):
#   1. deps-builder: install all deps (incl. native compile toolchain for
#                    better-sqlite3 / node-pty)
#   2. runtime:      slim image with runtime deps + app, tini as PID 1
#
# Configuration: mount config.yaml at /data/config.yaml
#   docker run -v ./config.yaml:/data/config.yaml:ro ...
# Secrets are injected as environment variables (env takes precedence over the config file).
#
# Build:
#   DOCKER_BUILDKIT=1 docker build -t memory-proxy:latest .
#
# Note: at runtime tsx executes the TypeScript directly (no precompilation). tsx is a devDependency,
# so the image keeps dev dependencies; the optional dependencies (better-sqlite3 / cost-guard) are kept
# for the sqlite storage backend and CostGuard smart routing.
# ──────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps-builder — install deps (with toolchain for native bindings)
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps-builder

# Uses the official Debian apt source (deb.debian.org). If builds are slow, swap in a mirror for local builds, e.g.:
#   sed -i 's|deb.debian.org|<your-apt-mirror>|g' /etc/apt/sources.list.d/debian.sources

# Native build toolchain (better-sqlite3 / node-pty need compiling)
# Cache apt packages with a BuildKit cache mount to avoid downloading them again
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates

WORKDIR /app

# node:22-slim ships npm@10.9.8, whose arborist has an "edgesOut" crash (a clean
# `npm install` reliably fails with `Cannot read properties of null (reading
# 'edgesOut')`). Upgrading to 11 avoids it without changing anything else in the build.
RUN npm install -g npm@11 --no-audit --no-fund

# Copy the package metadata first to make the most of the Docker layer cache.
COPY package.json package-lock.json ./

# npm ≥ 11.21 doesn't run dependencies' install scripts by default (allowScripts), so the native modules of
# better-sqlite3 / node-pty wouldn't compile and require would fail at runtime. Allow those two explicitly.
RUN printf 'allow-scripts[]=better-sqlite3\nallow-scripts[]=node-pty\n' > .npmrc

# Install every dependency (keep dev: tsx is needed at runtime; keep optional: sqlite/cost-guard).
# A BuildKit npm cache mount speeds up repeated builds a lot.
RUN --mount=type=cache,id=proxy-npm-cache,target=/root/.npm \
    npm install \
        --no-audit \
        --no-fund

# Copy the rest of the source (.dockerignore already excludes node_modules/.git/docs/scripts/gateway etc.)
COPY . .

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime — slim image
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Uses the official Debian apt source (deb.debian.org). If builds are slow, swap in a mirror yourself.

# Runtime essentials only (curl for HEALTHCHECK; tini handles signals)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates

WORKDIR /app

# Run as non-root (security baseline)
RUN groupadd -r app && useradd -r -g app -u 10001 -m app

# Copy the whole /app from the builder (including the file: symlink in node_modules pointing at packages/cost-guard)
# --chown sets the owner while copying, avoiding another chown -R over all of node_modules (slow and an extra layer)
COPY --from=deps-builder --chown=app:app /app /app

# Data / log directories (can be mounted as K8s PVCs)
RUN mkdir -p /data/wamf-memory-proxy /data/config /app/logs && \
    chown -R app:app /data /app/logs

USER app

# ── Runtime configuration ──
# Config file path: mount the yaml at /data/config.yaml
# Secrets are injected as environment variables (env takes precedence over the config file)
ENV NODE_ENV=production \
    PROXY_DB_PATH=/data/wamf-memory-proxy/proxy.db \
    NODE_OPTIONS="--max-old-space-size=1536"

EXPOSE 8096

# K8s-friendly health check (liveness/readiness should still be defined separately in the Deployment;
# this is a local runtime fallback).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8096/health || exit 1

# tini as PID 1 passes SIGTERM/SIGKILL cleanly to Node and its children and reaps zombie processes.
# tsx is a runtime dependency and executes TypeScript directly.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx/esm", "src/index.ts"]

# Default config file path (can be overridden by extra docker run arguments)
CMD ["--config", "/data/config.yaml"]
