# Publishing images to Docker Hub

Builds the three images and pushes them to the
[`agentmemory`](https://hub.docker.com/u/agentmemory) namespace on Docker Hub.

`publish.sh` is self-contained: it only depends on each component's own Dockerfile,
`deploy/panel-knowledge-combined/build.sh` and `MemoryPanel/scripts/secret-scan.sh`.

## Components and image names

| Component | Build context | Image |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/` (rsynced to a temporary context) | `agentmemory/memory-proxy` |
| `memory-hub` | `MemoryPanel/` + `MemoryKnowledge/` combined | `agentmemory/memory-hub` |

## Prerequisites

```bash
docker login docker.io          # the account needs push rights on agentmemory
docker buildx version           # buildx is required (the script creates the builder)
```

## Usage

```bash
cd deploy/dockerhub

# all three at once
VERSION=1.0.0 ./publish.sh all

# a single component
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# dry run: only secret-scan and context preparation, no build, no push
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# local single-architecture build to inspect the image contents, no push
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# also update :latest
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` is required and values starting with `dev-` are rejected, so development tags never reach the public registry.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VERSION` | none (required) | image tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | target registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | multi-architecture build targets |
| `ALSO_LATEST` | `0` | also push `:latest` |
| `PUSH` | `1` | `0` = local `--load`, single architecture, no push |
| `DRY_RUN` | `0` | `1` = only scanning and context preparation |
| `LOAD_PLATFORM` | `linux/amd64` | architecture of the local build when `PUSH=0` |
| `KEEP_CTX` | `0` | `1` = reuse the previous temporary context |
| `APT_MIRROR` | `deb.debian.org` | apt source during the build; set a faster mirror on internal networks |

## Faster apt during builds

All four Dockerfiles take the apt source from the `APT_MIRROR` build-arg. The default is the official Debian mirror,
which works out of the box on the public internet. To speed up builds on an internal network pass that one variable; the resulting images are the same:

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## Optional private modules

- `MemoryProxy/packages/cost-guard` is an optional extension and is not part of the public images. `publish.sh`
  generates a stub package in the temporary context so the dependency graph resolves; at runtime the dynamic import in
  `src/guard-adapter.ts` fails and the proxy falls back to plain pass-through forwarding.
- `MemoryCore/src/integrations` works the same way: it is excluded in `MemoryCore/.dockerignore`
  and the runtime uses the fallback.

## Verify

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
