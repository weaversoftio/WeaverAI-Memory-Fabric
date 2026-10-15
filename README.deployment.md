# Deployment and integration guide (single machine / multi-replica service)

> 📖 **This document covers deployment modes, Hermes integration and end-to-end verification.**
> For the plugin's core capabilities, configuration options and CLI tools, go back to the **[main README](README.md)**.

`memory-weaverai` offers **two independent deployment modes**. Both can be called by external Agents (typically Hermes) over the HTTP API, and each fits a different deployment scale and operational requirement:

| Mode | Storage | State backend | Multi-tenant | Fits |
|------|----------|----------|--------|----------|
| **Standalone (open-source single machine)** | SQLite + local files | in-process Map / Timer | single space | local development, single-Agent sidecar, all-in-one Docker, offline deployment |
| **Service (multi-replica)** | MongoDB (`mongodb` + `rowfs`/`mongofs`) | Redis (distributed lock + task queue) | many spaces, per `service_id` | K8s with several replicas, multi-tenant SaaS, memory shared by several Agents |

```
L0  raw conversation (Conversation)    ← written automatically
L1  atomic structured memory (Atomic)  ← extracted by the LLM + deduplicated
L2  scene blocks (Scene Blocks)        ← scene extraction by the LLM
L3  user profile (Persona)             ← persona synthesis by the LLM
```

Both modes share the same Gateway binary and the same v1/v2 HTTP API; only the configuration and backends differ. Switching modes means changing the `WAMF_DEPLOY_MODE` environment variable and pointing the storage variables (`STORE_MODE`, `FILE_STORE_MODE`, `MONGODB_*`) at a shared MongoDB.

---

## Quick start (3 steps)

```bash
# 1. Go into MemoryCore and install dependencies
cd MemoryCore
npm install

# 2. Configure the LLM
export WAMF_LLM_API_KEY="your-api-key"
export WAMF_LLM_BASE_URL="https://api.deepseek.com/v1"
export WAMF_LLM_MODEL="deepseek-chat"

# 3. Start the Gateway
npx tsx src/gateway/server.ts
```

The Gateway listens on `http://127.0.0.1:8420` by default and stores data in `~/.weaverai-memory-fabric/memory-wamf/`.

---

## Deployment modes

### Standalone mode (single machine)

No outside dependencies; all data is stored locally. Fits: local development, a single-Agent sidecar, all-in-one Docker deployments.

**Storage**: SQLite (vectors + records) + local file system (L2/L3 documents)
**State management**: in-process Map/Timer

#### Environment variables

```bash
# Required — LLM
export WAMF_LLM_API_KEY="sk-xxx"
export WAMF_LLM_BASE_URL="https://api.deepseek.com/v1"   # default https://api.openai.com/v1
export WAMF_LLM_MODEL="deepseek-chat"                     # default gpt-4o
export WAMF_LLM_MAX_TOKENS=4096
export WAMF_LLM_TIMEOUT_MS=120000

# Optional — service
export WAMF_GATEWAY_PORT=8420            # listening port, default 8420
export WAMF_GATEWAY_HOST="127.0.0.1"    # listening address, default 127.0.0.1
export WAMF_DATA_DIR="~/.weaverai-memory-fabric/memory-wamf"  # data directory
```

#### YAML config file (optional)

Config file search order: `$WAMF_GATEWAY_CONFIG` → `./wamf-gateway.yaml` → `<dataDir>/wamf-gateway.yaml`

```yaml
# wamf-gateway.yaml — Standalone mode
server:
  port: 8420
  host: "127.0.0.1"

data:
  baseDir: "~/.weaverai-memory-fabric/memory-wamf"

llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${WAMF_LLM_API_KEY}"
  model: "deepseek-chat"
  maxTokens: 4096
  timeoutMs: 120000

# memory settings (optional, all have sensible defaults)
memory:
  capture:
    enabled: true
    excludeAgents: []
  recall:
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"            # hybrid / embedding / keyword
  embedding:
    enabled: true
    provider: "openai"            # none / openai / deepseek / qclaw
    baseUrl: "${WAMF_LLM_BASE_URL}"
    apiKey: "${WAMF_LLM_API_KEY}"
    model: "text-embedding-3-small"
    dimensions: 1536
  storeBackend: "sqlite"          # sqlite or mongodb (the Gateway uses the STORE_MODE env var instead)
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutMs: 30000
    l2IntervalMs: 300000
    l3IntervalMs: 600000
```

#### Docker deployment

```bash
# Gateway only
docker run -d \
  -e WAMF_LLM_API_KEY="sk-xxx" \
  -e WAMF_LLM_BASE_URL="https://api.deepseek.com/v1" \
  -e WAMF_LLM_MODEL="deepseek-chat" \
  -e WAMF_GATEWAY_HOST="0.0.0.0" \
  -p 8420:8420 \
  -v wamf-data:/root/.memory-weaverai/memory-wamf \
  agentmemory/hermes-memory:latest
```

#### Data directory layout

```
~/.weaverai-memory-fabric/memory-wamf/
  ├── vectors.db              # SQLite vector database (L0 + L1)
  ├── conversations/          # L0 raw conversation JSONL
  ├── records/                # L1 structured memories
  ├── scene_blocks/           # L2 scene Markdown files
  ├── persona.md              # L3 user profile
  └── checkpoint.json         # pipeline progress
```

---

### Service mode

Uses a shared MongoDB deployment as the data plane and scales horizontally across replicas. Fits: K8s clusters, multi-tenant SaaS, memory shared by several Agents.

**Storage**: MongoDB (`STORE_MODE=mongodb`: L0/L1/profile/skill documents, with native mongot BM25 search) + the `rowfs` file store (profile rows in MongoDB; the other L2/L3 documents in the `mongofs` leg, i.e. in the same MongoDB)
**State management**: Redis (distributed lock + task queue)
**Config source**: environment variables and/or the YAML config file

> All replicas must point at the same MongoDB cluster (a replica set with mongot for full-text search — self-hosted or MongoDB Atlas). The `local` file store (`FILE_STORE_MODE=local` or `FILE_STORE_OTHERS=local`) is per-node and therefore not suitable for multi-replica deployments.

#### Environment variables

```bash
# ── Deployment mode ──
export WAMF_DEPLOY_MODE="service"           # key: enables service mode

# ── LLM (same as standalone) ──
export WAMF_LLM_API_KEY="sk-xxx"
export WAMF_LLM_BASE_URL="https://api.deepseek.com/v1"
export WAMF_LLM_MODEL="deepseek-chat"

# ── Service port ──
export WAMF_GATEWAY_PORT=3100
export WAMF_GATEWAY_HOST="0.0.0.0"

# ── Redis (distributed state backend) ──
export STATE_BACKEND="redis"                # redis or local (single-machine testing)
export REDIS_HOST="redis.example.com"
export REDIS_PORT=6379
export REDIS_PASSWORD="your-password"
export REDIS_KEY_PREFIX="wamf_memory"

# ── MongoDB data plane ──
export STORE_MODE="mongodb"                 # DB backend: sqlite (default) or mongodb
export MONGODB_ENDPOINT="mongodb://mongo.example.com:27017/?replicaSet=rs0"
export MONGODB_USER="wamf"                  # leave empty when the connection string carries auth
export MONGODB_PASSWORD="your-password"
export MONGODB_DATABASE="memory-production"

# ── File store (L2/L3 documents + profile) ──
export FILE_STORE_MODE="rowfs"              # local (default) or rowfs
export FILE_STORE_OTHERS="mongofs"          # rowfs "others" leg: local or mongofs (mongofs requires STORE_MODE=mongodb)

# ── Optional tuning ──
export CONFIG_MAX_INSTANCES=1000            # maximum number of cached instances
export SCANNER_SPACES="space1,space2"       # spaces the Timer Scanner scans
export WAMF_SPACE_ID="default"              # space ID of this instance
```

#### YAML config file

```yaml
# wamf-gateway.yaml — Service mode
deployMode: service

server:
  port: 3100
  host: "0.0.0.0"

data:
  baseDir: "/data/wamf-memory"
  fileStore: "rowfs"                   # same as FILE_STORE_MODE
  fileStoreOthers: "mongofs"           # same as FILE_STORE_OTHERS

llm:
  baseUrl: "${WAMF_LLM_BASE_URL}"
  apiKey: "${WAMF_LLM_API_KEY}"
  model: "deepseek-chat"

# The DB backend is selected by the STORE_MODE / MONGODB_* environment variables
# (the Gateway does not read memory.storeBackend).
memory:
  embedding:
    enabled: true
    provider: "openai"
    baseUrl: "${WAMF_LLM_BASE_URL}"
    apiKey: "${WAMF_LLM_API_KEY}"
    model: "text-embedding-3-small"
    dimensions: 1536
  recall:
    strategy: "hybrid"
    maxResults: 10
```

#### K8s deployment

```yaml
# Core environment variables (injected via ConfigMap/Secret)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wamf-memory-gateway
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: gateway
          image: agentmemory/hermes-memory:latest
          env:
            - name: WAMF_DEPLOY_MODE
              value: "service"
            - name: WAMF_GATEWAY_PORT
              value: "3100"
            - name: WAMF_GATEWAY_HOST
              value: "0.0.0.0"
            - name: STATE_BACKEND
              value: "redis"
            - name: REDIS_HOST
              valueFrom:
                configMapKeyRef:
                  name: wamf-config
                  key: redis-host
            - name: STORE_MODE
              value: "mongodb"
            - name: FILE_STORE_MODE
              value: "rowfs"
            - name: FILE_STORE_OTHERS
              value: "mongofs"
            - name: MONGODB_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: wamf-secrets
                  key: mongodb-endpoint
            - name: MONGODB_DATABASE
              value: "memory-production"
          ports:
            - containerPort: 3100
---
apiVersion: v1
kind: Service
metadata:
  name: wamf-memory-gateway
spec:
  selector:
    app: wamf-memory-gateway
  ports:
    - port: 3100
      targetPort: 3100
```

#### Multi-replica architecture

```
                    ┌─────────────┐
                    │  Hermes #1  │─┐
                    └─────────────┘ │
                    ┌─────────────┐ │    ┌──────────────────┐    ┌──────────────┐
                    │  Hermes #2  │─┼───→│  WAMF Gateway    │───→│   MongoDB    │
                    └─────────────┘ │    │  (N replicas)    │    │ L0/L1 + BM25 │
                    ┌─────────────┐ │    │                  │    │ profile rows │
                    │  Hermes #3  │─┘    │  ┌─ Scanner ─┐   │    │ mongofs docs │
                    └─────────────┘      │  │  Worker   │   │    └──────────────┘
                                         │  └───────────┘   │
  Each Hermes uses a unique              └──────────────────┘
  x-wamf-service-id                              │
  for data isolation                     ┌──────────────┐
                                         │    Redis     │
                                         │ state + tasks│
                                         └──────────────┘
```

---

## Hermes plugin configuration

There are two Hermes plugins for different deployment scenarios.

### v1 plugin: `memory_weaverai` (single machine, self-managed)

Starts and manages the Gateway subprocess automatically; no manual Gateway deployment needed. Fits single-Agent local/Docker deployments.

**Install the plugin**:

```bash
# symlink (recommended for development)
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_weaverai" \
      <hermes-agent>/plugins/memory/memory_weaverai

# copy (production)
cp -r MemoryCore/hermes-plugin/memory/memory_weaverai \
      <hermes-agent>/plugins/memory/memory_weaverai
```

**Hermes config** (`~/.hermes/config.yaml`):

```yaml
memory:
  provider: memory_weaverai
```

**Environment variables**:

| Variable | Default | Description |
|------|--------|------|
| `WAMF_LLM_API_KEY` | (required) | LLM API key |
| `WAMF_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API address |
| `WAMF_LLM_MODEL` | `gpt-4o` | LLM model name |
| `MEMORY_WEAVERAI_GATEWAY_PORT` | `8420` | Gateway listening port |
| `MEMORY_WEAVERAI_GATEWAY_HOST` | `127.0.0.1` | Gateway listening address |
| `MEMORY_WEAVERAI_GATEWAY_CMD` | (auto-detected) | custom Gateway start command |

**Tools**:

| Tool | Purpose |
|------|------|
| `memory_weaverai_memory_search` | search L1 structured memories |
| `memory_weaverai_conversation_search` | search the L0 raw conversation |

**Features**: starts the Gateway subprocess automatically, health-check watchdog (every 10s), automatic recovery, circuit breaker, background sync thread.

---

### v2 plugin: `memory_weaverai_v2` (external Gateway)

Connects to an already running Gateway service (local or remote) over the v2 REST API. Fits a Gateway shared by several Agents, and K8s cluster deployments.

**Install the plugin**:

```bash
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_weaverai_v2" \
      <hermes-agent>/plugins/memory/memory_weaverai_v2
```

**Install the Python SDK**:

```bash
# From a checkout of this repository (there is no published package for this fork)
pip install ./sdk/memory-core/python
```

**Hermes config** (`~/.hermes/config.yaml`):

```yaml
memory:
  provider: memory_weaverai_v2
```

**Environment variables**:

| Variable | Default | Description |
|------|--------|------|
| `WAMF_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | Gateway service address |
| `WAMF_MEMORY_API_KEY` | `""` | Bearer token (required in service mode) |
| `WAMF_MEMORY_SERVICE_ID` | `""` | instance/space ID (multi-tenant isolation key) |

**Tools**:

| Tool | Purpose | Parameters |
|------|------|------|
| `wamf_memory_search` | search L1 structured memories | `query` (required), `limit` (default 5) |
| `wamf_conversation_search` | search the L0 raw conversation | `query` (required), `limit` (default 5) |
| `wamf_read_scene` | read L2 scene content | `scene_id` (required) |

**Features**: based on the `wamf_memory` Python SDK (httpx), Bearer token auth, multi-tenant isolation, circuit breaker (5 failures → 60s cool-down), thread-safe.

---

### Which to choose

| Scenario | Plugin | Deployment mode | Gateway |
|------|----------|----------|---------|
| local development / single Agent | `memory_weaverai` (v1) | standalone | managed by the plugin |
| single Docker container | `memory_weaverai` (v1) | standalone | managed by the plugin |
| memory shared by several Agents | `memory_weaverai_v2` (v2) | service | deployed separately |
| K8s cluster | `memory_weaverai_v2` (v2) | service | K8s Service |
| multi-tenant SaaS | `memory_weaverai_v2` (v2) | service | several replicas + Redis |

---

## API overview

### v1 API (standalone-compatible)

| Method | Path | Description |
|------|------|------|
| GET | `/health` | health check |
| POST | `/recall` | memory recall (prefetch) |
| POST | `/capture` | conversation capture (sync_turn) |
| POST | `/search/memories` | L1 memory search |
| POST | `/search/conversations` | L0 conversation search |
| POST | `/session/end` | end session + flush |
| POST | `/seed` | bulk-import past conversations |

### v2 API (multi-tenant, needs a Bearer token + x-wamf-service-id)

| Method | Path | Description |
|------|------|------|
| POST | `/v2/conversation/add` | L0 add conversation |
| POST | `/v2/conversation/query` | L0 query conversation |
| POST | `/v2/conversation/search` | L0 search conversation |
| POST | `/v2/conversation/delete` | L0 delete conversation |
| POST | `/v2/atomic/add` | L1 add memory |
| POST | `/v2/atomic/query` | L1 query memories |
| POST | `/v2/atomic/search` | L1 search memories |
| POST | `/v2/atomic/delete` | L1 delete memory |
| POST | `/v2/scenario/ls` | L2 list scenes |
| POST | `/v2/scenario/read` | L2 read scene |
| POST | `/v2/scenario/write` | L2 write scene |
| POST | `/v2/scenario/rm` | L2 delete scene |
| POST | `/v2/persona/read` | L3 read profile |
| POST | `/v2/persona/write` | L3 write profile |

---

## Configuration reference

### All environment variables

| Variable | Default | Mode | Description |
|------|--------|----------|------|
| **Gateway basics** |
| `WAMF_DEPLOY_MODE` | `standalone` | all | `standalone` or `service` |
| `WAMF_GATEWAY_PORT` | `8420` | all | listening port |
| `WAMF_GATEWAY_HOST` | `127.0.0.1` | all | listening address |
| `WAMF_DATA_DIR` | `~/.weaverai-memory-fabric/memory-wamf` | all | data directory |
| `WAMF_GATEWAY_CONFIG` | (searched) | all | config file path |
| **LLM** |
| `WAMF_LLM_API_KEY` | `""` | all | LLM API key |
| `WAMF_LLM_BASE_URL` | `https://api.openai.com/v1` | all | LLM API address |
| `WAMF_LLM_MODEL` | `gpt-4o` | all | model name |
| `WAMF_LLM_MAX_TOKENS` | `4096` | all | maximum output tokens |
| `WAMF_LLM_TIMEOUT_MS` | `120000` | all | LLM request timeout |
| **Service mode** |
| `STATE_BACKEND` | (auto) | service | `redis` or `local` |
| `REDIS_HOST` | `127.0.0.1` | service | Redis address |
| `REDIS_PORT` | `6379` | service | Redis port |
| `REDIS_PASSWORD` | (none) | service | Redis password |
| `REDIS_KEY_PREFIX` | `wamf_memory` | service | Redis key prefix |
| **Storage backends** |
| `STORE_MODE` | `sqlite` | all | DB backend: `sqlite` or `mongodb` |
| `FILE_STORE_MODE` | `local` | all | file store: `local` or `rowfs` |
| `FILE_STORE_OTHERS` | `local` | all | `rowfs` "others" leg: `local` or `mongofs` (`mongofs` requires `STORE_MODE=mongodb`) |
| `MONGODB_ENDPOINT` | `""` | mongodb | MongoDB connection string (required when `STORE_MODE=mongodb`) |
| `MONGODB_USER` | `""` | mongodb | username (empty when the connection string carries auth) |
| `MONGODB_PASSWORD` | `""` | mongodb | password |
| `MONGODB_DATABASE` | `""` | mongodb | database name (required when `STORE_MODE=mongodb`) |
| **Tuning** |
| `CONFIG_MAX_INSTANCES` | `1000` | service | maximum number of cached instances |
| `SCANNER_SPACES` | `default` | service | spaces the Scanner scans |
| `WAMF_SPACE_ID` | `default` | service | current space ID |

---

## Typical deployment examples

### Example 1: local development (minimal)

```bash
export WAMF_LLM_API_KEY="sk-xxx"
export WAMF_LLM_BASE_URL="https://api.deepseek.com/v1"
export WAMF_LLM_MODEL="deepseek-chat"
npx tsx src/gateway/server.ts
```

### Example 2: Docker all-in-one (Hermes + Gateway)

```bash
docker run -d \
  -e MODEL_API_KEY="sk-xxx" \
  -e MODEL_BASE_URL="https://api.deepseek.com/v1" \
  -e MODEL_NAME="deepseek-chat" \
  -p 8420:8420 \
  -v hermes-data:/home/agentuser \
  agentmemory/hermes-memory:latest
```

### Example 3: several Agents + a shared Gateway

```bash
# 1. Start the Gateway (service mode)
cd MemoryCore
WAMF_DEPLOY_MODE=service \
WAMF_GATEWAY_PORT=3100 \
WAMF_GATEWAY_HOST=0.0.0.0 \
STATE_BACKEND=local \
STORE_MODE=mongodb \
MONGODB_ENDPOINT="mongodb://mongo.example.com:27017/?replicaSet=rs0" \
MONGODB_DATABASE="memory-shared" \
FILE_STORE_MODE=rowfs \
FILE_STORE_OTHERS=mongofs \
npx tsx src/gateway/server.ts

# 2. Give each Hermes Agent its own service_id
# Agent A:
export WAMF_MEMORY_ENDPOINT="http://gateway-host:3100"
export WAMF_MEMORY_API_KEY="shared-key"
export WAMF_MEMORY_SERVICE_ID="agent-code-assistant"

# Agent B:
export WAMF_MEMORY_ENDPOINT="http://gateway-host:3100"
export WAMF_MEMORY_API_KEY="shared-key"
export WAMF_MEMORY_SERVICE_ID="agent-customer-support"
```

### Example 4: K8s production deployment

This repository doesn't contain ready-to-apply Kubernetes manifests (except the WAIP chart in `deploy/waip/agent-memory/`); use the Deployment, ConfigMap and Secret examples in this section as a template and adjust them to your images, domains and cluster.

---

## End-to-end verification (E2E)

The repository has two ready-to-run E2E scripts, one per deployment mode. Both run the whole chain with a real Hermes API Server + a real LLM + a real Gateway process.

### Standalone E2E: `__tests__/e2e/test_hermes_standalone_e2e.py`

Verifies the open-source single-machine chain:

```
Hermes API Server → memory_weaverai (v1 plugin) → self-managed Gateway subprocess → SQLite + local FS
```

Covers:
- Hermes API Server starts and `/health` passes
- the first chat triggers the v1 plugin's `initialize()`, which starts the Node subprocess with `pnpm exec tsx src/gateway/server.ts`
- Gateway `/health` reports `vectorStore: true`
- 3 conversation turns: plant a marker → the model recalls and echoes it → cross-session recall via the v1 plugin's prefetch
- side channel: query the Gateway's `/search/conversations` directly and find this run's marker
- tool layer: `/search/conversations` / `/search/memories` respond normally

```bash
hermes-agent/.venv/bin/python MemoryCore/__tests__/e2e/test_hermes_standalone_e2e.py
```

Measured result: **16 / 16 passed**.

### Service E2E: `MemoryCore/__tests__/e2e/test_hermes_service_e2e.py`

Verifies the multi-replica service chain:

```
2 Gateway processes (service mode, sharing one MongoDB)
Hermes → memory_weaverai_v2 (v2 plugin, wamf_memory SDK) → Gateway-1 → MongoDB
Side channel verified on Gateway-2 → proves MongoDB is really shared
```

Covers:
- GW1 + GW2 + Hermes all ready
- both Gateways in service mode (`stateBackend=connected` + `timerScanner` running)
- Hermes `/v1/models` returns 200 and the v2 plugin loads
- 3 conversation turns written through the v2 plugin into GW1 → shared MongoDB
- **cross-Gateway consistency**: a search on GW2 finds the marker GW1 wrote
- GW2 `/conversation/query` returns every message of the main session
- cross-session prefetch: the model recalls the marker in a new session through the v2 plugin
- L1 add on GW1 → immediately visible via GW2 `/atomic/query` (proves shared MongoDB reads/writes)
- automatic backup/restore of the `memory.provider` field in `~/.hermes/config.yaml`

```bash
# Prerequisite: install the SDK into the Hermes venv (once)
hermes-agent/.venv/bin/python -m pip install -e sdk/memory-core/python/

# Run
hermes-agent/.venv/bin/python __tests__/e2e/test_hermes_service_e2e.py
```

Measured result: **23 / 23 passed** (cross-Gateway consistency, cross-session recall and cross-GW L1 sharing all pass).

### Prerequisites for both scripts

1. the `hermes` CLI is installed (default path `~/.hermes/bin/hermes`)
2. `model.api_key` / `model.base_url` / `model.default` in `~/.hermes/config.yaml` point to a working LLM
3. the v1 / v2 plugins are linked into `hermes-agent/plugins/memory/` (installed by default)
4. service mode additionally needs a reachable MongoDB (`MONGODB_ENDPOINT` / `MONGODB_DATABASE`) + `pip install -e sdk/memory-core/python/` (SDK for Hermes)
