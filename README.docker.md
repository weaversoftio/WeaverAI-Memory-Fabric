# WeaverAI Memory Fabric — Docker (Memory Core)

Long-term memory service for AI Agents. It gives any Agent framework four progressive memory layers (L0 conversation → L1 atomic memory → L2 scene summaries → L3 user profile).

## Image

| Item | Value |
|------|---|
| Image name | `weaveraidb-agent-memory` |
| Base image | `node:22-slim` |
| Size | ~920MB |
| Port | 8420 |
| Runs as | wamf (uid 10001) |
| PID 1 | tini |

## Quick start

The commands below run inside `MemoryCore/`; if you are at the repository root, `cd MemoryCore` first.

### 1. Build the image

```bash
docker build -t weaveraidb-agent-memory:latest .
```

### 2. Prepare the config file

There are two config templates:

| Template | Fits |
|------|---------|
| `wamf-gateway.standalone.yaml` | local development, single machine, no outside dependencies (sqlite) |
| `wamf-gateway.local-mongo.yaml` | MongoDB data plane (used by `docker-compose.local-mongo.yaml`) |

Copy a template and edit it:

```bash
# standalone mode (sqlite)
cp wamf-gateway.standalone.yaml wamf-gateway.yaml

# MongoDB data plane
cp wamf-gateway.local-mongo.yaml wamf-gateway.yaml
```

For multi-replica / multi-tenant (service) deployments, set `deployMode: service` and point every replica at the same Redis and the same MongoDB (see the service-mode example in step 3 and [README.deployment.md](./README.deployment.md#service-mode)).

### 3. Start the container

**Standalone mode (minimal):**

```bash
docker run -d --name agent-memory \
  -v $(pwd)/wamf-gateway.yaml:/data/config/wamf-gateway.yaml:ro \
  -e WAMF_LLM_API_KEY=sk-your-key \
  -p 8420:8420 \
  weaveraidb-agent-memory:latest
```

**Service mode (needs Redis + MongoDB):**

```bash
# Start Redis (if you have no remote Redis)
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Start the Memory Service against a shared MongoDB (replica set with mongot)
docker run -d --name agent-memory \
  -v $(pwd)/wamf-gateway.yaml:/data/config/wamf-gateway.yaml:ro \
  -e WAMF_DEPLOY_MODE=service \
  -e WAMF_LLM_API_KEY=sk-your-key \
  -e STATE_BACKEND=redis \
  -e REDIS_HOST=host.docker.internal \
  -e STORE_MODE=mongodb \
  -e MONGODB_ENDPOINT="mongodb://your-mongo:27017/?replicaSet=rs0" \
  -e MONGODB_DATABASE=wamf_memory \
  -e FILE_STORE_MODE=rowfs \
  -e FILE_STORE_OTHERS=mongofs \
  -p 8420:8420 \
  weaveraidb-agent-memory:latest
```

**Docker Compose, one command (local MongoDB with mongot, standalone mode):**

```bash
WAMF_LLM_API_KEY=sk-your-key WAMF_LLM_BASE_URL=https://api.openai.com/v1 WAMF_LLM_MODEL=gpt-4o-mini \
  docker compose -f docker-compose.local-mongo.yaml up --build
```

### 4. Check the service

```bash
curl http://localhost:8420/health
```

A healthy response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "services": {
    "timerScanner": { "isLeader": true },
    "pipelineWorker": { "workerId": "worker-xxx" },
    "stateBackend": "connected"
  }
}
```

## Configuration

### Config file + environment variables (recommended)

Every setting can come from the **YAML config file** or an **environment variable**; environment variables win.

Inside the container the config file path comes from the `WAMF_GATEWAY_CONFIG` environment variable, default `/data/config/wamf-gateway.yaml`.

```
┌─────────────────────────────┐
│  env vars (highest)         │  ← secrets
├─────────────────────────────┤
│  wamf-gateway.yaml          │  ← mounted from a ConfigMap
├─────────────────────────────┤
│  code defaults              │  ← fallback
└─────────────────────────────┘
```

### Config file layout

```yaml
deployMode: service          # standalone | service

server:
  port: 8420
  host: "0.0.0.0"

llm:                         # LLM API (OpenAI-compatible)
  baseUrl: "https://api.openai.com/v1"
  apiKey: "${WAMF_LLM_API_KEY}"
  model: "gpt-4o-mini"

redis:                       # Redis (required in service mode)
  host: "redis:6379"
  keyPrefix: "wamf_memory"

data:
  baseDir: /data/wamf-memory
  fileStore: "rowfs"         # local | rowfs (env FILE_STORE_MODE)
  fileStoreOthers: "mongofs" # local | mongofs (env FILE_STORE_OTHERS)

scanner:                     # Timer Scanner
  intervalMs: 500

worker:                      # Pipeline Worker
  pollMs: 200

memory:                      # memory engine tuning
  pipeline:
    everyNConversations: 5
    enableWarmup: true
  recall:
    maxResults: 5
    strategy: "hybrid"
```

The DB backend is selected only by environment variables (`STORE_MODE` + `MONGODB_*`), not by the config file.

For the full set of options see `wamf-gateway.standalone.yaml` and `wamf-gateway.local-mongo.yaml`.

### Environment variables and their config file keys

| Environment variable | YAML path | Default | Description |
|---------|----------|--------|------|
| `WAMF_DEPLOY_MODE` | `deployMode` | `standalone` | deployment mode |
| `WAMF_GATEWAY_CONFIG` | — | `/data/config/wamf-gateway.yaml` | config file path |
| `WAMF_LLM_API_KEY` | `llm.apiKey` | — | LLM API key |
| `WAMF_LLM_BASE_URL` | `llm.baseUrl` | `https://api.openai.com/v1` | LLM address |
| `WAMF_LLM_MODEL` | `llm.model` | `gpt-4o` | model name |
| `REDIS_HOST` | `redis.host` | `127.0.0.1` | Redis address |
| `REDIS_PORT` | `redis.port` | `6379` | Redis port |
| `REDIS_PASSWORD` | `redis.password` | — | Redis password |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` | `wamf_memory` | key prefix |
| `STATE_BACKEND` | `stateBackend` | auto | `redis` / `local` |
| `STORE_MODE` | — | `sqlite` | DB backend: `sqlite` / `mongodb` |
| `MONGODB_ENDPOINT` | — | — | MongoDB connection string (required with `STORE_MODE=mongodb`) |
| `MONGODB_USER` | — | — | MongoDB username |
| `MONGODB_PASSWORD` | — | — | MongoDB password |
| `MONGODB_DATABASE` | — | — | MongoDB database (required with `STORE_MODE=mongodb`) |
| `FILE_STORE_MODE` | `data.fileStore` | `local` | file store: `local` / `rowfs` |
| `FILE_STORE_OTHERS` | `data.fileStoreOthers` | `local` | `rowfs` others leg: `local` / `mongofs` |
| `SCANNER_INTERVAL_MS` | `scanner.intervalMs` | `500` | scan interval |
| `WORKER_POLL_MS` | `worker.pollMs` | `200` | worker polling |

## K8s deployment

This repository doesn't contain ready-to-apply Kubernetes manifests (the WAIP chart in `deploy/waip/agent-memory/` aside); these are the core pieces a K8s deployment needs:

1. a **ConfigMap** that mounts `wamf-gateway.yaml` into `/app/config/`
2. a **Secret** that injects `WAMF_LLM_API_KEY` + `REDIS_PASSWORD` as environment variables
3. a **Deployment** that sets `WAMF_GATEWAY_CONFIG=/data/config/wamf-gateway.yaml`

```yaml
# Key parts of the Deployment
env:
  - name: WAMF_GATEWAY_CONFIG
    value: /data/config/wamf-gateway.yaml
  - name: WAMF_LLM_API_KEY
    valueFrom:
      secretKeyRef:
        name: wamf-memory-secrets
        key: WAMF_LLM_API_KEY
volumeMounts:
  - name: config-volume
    mountPath: /app/config
    readOnly: true
volumes:
  - name: config-volume
    configMap:
      name: wamf-memory-config
```

## API overview

| Method | Path | Description |
|------|------|------|
| GET | `/health` | health check |
| POST | `/recall` | memory recall |
| POST | `/capture` | write a conversation |
| POST | `/search/memories` | L1 memory search |
| POST | `/search/conversations` | L0 conversation search |
| POST | `/session/end` | end the session |
| POST | `/v2/*` | v2 multi-tenant API (needs a Bearer token) |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              WeaverAI Memory Fabric (Core)           │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Gateway  │  │ TimerScanner │  │ PipelineWorker│  │
│  │ HTTP API │  │ 500ms scan   │  │ competing     │  │
│  │          │  │              │  │ consumers     │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│       │               │                 │            │
│  ┌────▼─────────────────────────────────▼────────┐  │
│  │          IStateBackend (Redis / Local)         │  │
│  └───────────────────────────────────────────────┘  │
│       │                                              │
│  ┌────▼───────────┐  ┌────────────┐  ┌───────────┐  │
│  │  WamfCore      │  │ StorePool  │  │ FileStore │  │
│  │  L0→L1→L2→L3   │  │ sqlite /   │  │ local /   │  │
│  │                │  │ mongodb    │  │ rowfs     │  │
│  └────────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │               │
    ┌────▼────┐         ┌─────▼─────────────────▼─────┐
    │  LLM    │         │  local disk  or  MongoDB    │
    │ API     │         │  (mongot BM25, mongofs)     │
    └─────────┘         └─────────────────────────────┘
```

## Files

```
.
├── MemoryCore/
│   ├── Dockerfile                       # image build
│   ├── docker-compose.local-mongo.yaml  # local one-command test (MongoDB + mongot)
│   ├── wamf-gateway.standalone.yaml     # standalone config template (sqlite)
│   ├── wamf-gateway.local-mongo.yaml    # MongoDB config template
│   └── src/gateway/server.ts            # service entry point
```

## License

[MIT](./LICENSE) © WeaverAI / Weaversoft 2026
