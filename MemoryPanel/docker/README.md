# Docker deployment

This directory holds the container build files for **team-memory-control** (the Control panel backend).

## Layout

```
docker/
├── README.md                          # this file
└── local/
    ├── Dockerfile.local               # single Control image (multi-stage build)
    └── Dockerfile.local.dockerignore  # build context ignore rules
```

## Images

| Image name (example) | Dockerfile | Build context | Description |
|----------------|------------|------------|------|
| `team-memory-control:local` | `docker/local/Dockerfile.local` | **repository root** `.` | Control HTTP service, default `:8123` |

---

## `docker/local/Dockerfile.local`

### Purpose

Builds the single **Control panel** image: the backend runs `src/index.ts` directly with `tsx` (stateless panel, entry `src/panel/`), and the `web/` frontend is compiled in a separate stage and served as static assets.

### Stages

| Stage | Role |
|-------|------|
| `base` | `node:22-slim` + native build toolchain (`better-sqlite3` needs `python3`/`make`/`g++`) |
| `ui-builder` | compiles `web/`: `npm install` + `npm run build` → `dist/` |
| `runtime` | copies the whole source tree, runs `npm install`, embeds the UI build and starts Control |

### Build arguments

| Argument | Default | Description |
|------|--------|------|
| `PANEL_UI` | `web` | frontend project directory (the active panel is `web/`; `frontend/` is a legacy directory and no longer maintained) |
| `WEB_UI` | `1` | `1` builds the panel UI normally; `0` skips the UI build and generates a placeholder `index.html` (see "Disabling the panel UI build" below) |

At runtime `METADATA_INSTANCES_CONFIG` points at the instance registry and `UI_DIST_DIR=./web/dist` serves the frontend.

### Port and health check

- Port: `8123`
- Health check: `GET http://127.0.0.1:8123/health`

---

## Build and run

### Prerequisites

- Docker (BuildKit recommended)
- Node engine requirement as in the repository: `>=22` (see the root `package.json`)
- run the build from the **repository root** (the context is the whole repository)

```bash
# at the repository root
docker build \
  --build-arg PANEL_UI=web \
  -t team-memory-control:local \
  -f docker/local/Dockerfile.local .

docker run -d --name tmc-control \
  -p 8123:8123 \
  -e UI_DIST_DIR=./web/dist \
  -e METADATA_INSTANCES_CONFIG=/app/config/metadata-instances.json \
  -e KNOWLEDGE_SERVICE_URL=http://host.docker.internal:8421 \
  -e KNOWLEDGE_AUTH_TOKEN=<ks-token> \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=http://host.docker.internal:8096 \
  -v "$(pwd)/config/metadata-instances.json:/app/config/metadata-instances.json:ro" \
  team-memory-control:local
```

Log in: open `http://localhost:8123/` in the browser, pick the instance ID and enter the Gateway **user_key**. The instance registry fields are described in [`config/metadata-instances.README.md`](../config/metadata-instances.README.md).

If the Gateway runs on the host, `gateway_endpoint` in the mounted `metadata-instances.json` must be an address the container can reach (e.g. `http://host.docker.internal:8420`), not `127.0.0.1`.

### Disabling the panel UI build (`WEB_UI=0`)

The panel UI depends on internal packages such as `@weaverai/*` that public npm mirrors don't provide. If the build environment **can't reach the internal npm registry** (offline machines, external CI), `npm install` fails. Skip the UI build with `WEB_UI=0`:

```bash
docker build \
  --build-arg PANEL_UI=web \
  --build-arg WEB_UI=0 \
  -t team-memory-control:local-no-ui \
  -f docker/local/Dockerfile.local .
```

The image gets a placeholder `dist/index.html`. **The Control backend, `/health` and `/api/*` work fully**; only the static panel pages are unavailable (frontend routes return a placeholder notice). If you need the panel UI, use the default `WEB_UI=1` and make sure the internal dependencies can be fetched.

### Common environment variables

| Variable | Default | Description |
|------|------|------|
| `UI_DIST_DIR` | `./web/dist` | static frontend directory (the Dockerfile sets it to `./${PANEL_UI}/dist` via `ENV`) |
| `METADATA_INSTANCES_CONFIG` | `./config/metadata-instances.json` | instance registry path |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | timeout for forwarding to the Gateway |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:8421` | Knowledge Service (KS) address; inside a container it must point at a KS the container can reach |
| `KNOWLEDGE_AUTH_TOKEN` | — | bearer token for calling KS, set per deployment |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | timeout for calls to KS |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `true` | at startup, make sure each instance has a KS LLM binding (billed through the proxy); `false` skips it |
| `KNOWLEDGE_LLM_PROXY_BASE_URL` | `http://127.0.0.1:8096` | LLM billing proxy address (must be reachable from the container) |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | locally you can set `LOG_FORMAT=pretty` |

> Note: `LLM_MODEL` (the wiki ingest model) is not configured in the Panel; it is decided by `LLM_MODEL` on the KS side (default `Memory-Model`).

---

## `docker/local/Dockerfile.local.dockerignore`

BuildKit prefers `<dockerfile>.dockerignore` over the repository root `.dockerignore`.

Main exclusions:

- `**/node_modules`, `**/dist`: keeps host-compiled `better-sqlite3` and stale builds out of the image
- `.env`, `data/`, `*.db`: keeps secrets and local data out of the image
- `docs/`, test reports, etc.: smaller build context

**Security note**: `config/metadata-instances.json` **does** go into the image with `COPY . .`. If it contains a real `api_key`, production images should mount it at runtime instead, or exclude the file in the dockerignore and require a `-v` mount.

---

## Local development comparison

| Method | Command |
|------|------|
| from source | `pnpm dev` |
| single Docker image | see `docker build` / `docker run` above |

---

## Troubleshooting

| Symptom | Likely cause |
|------|----------|
| `GET /` 404 | `UI_DIST_DIR` isn't `./web/dist`, or the frontend stage `npm run build` failed |
| API 401 / no team after login | `gateway_endpoint` in `metadata-instances.json` is unreachable, or `api_key` doesn't match the Gateway |
| knowledge assets fail to load / 500 | `KNOWLEDGE_SERVICE_URL` is unreachable from the container, or `KNOWLEDGE_AUTH_TOKEN` doesn't match |
| startup hangs at "ensure LLM binding" | `KNOWLEDGE_LLM_PROXY_BASE_URL` is unreachable from the container; set `KNOWLEDGE_LLM_BINDING_SYNC=false` to skip it temporarily |
