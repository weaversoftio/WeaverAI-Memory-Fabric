# WeaverAI Memory Fabric (combined image)

**WeaverAI Memory Fabric** ships as a combined image: one container runs two services, the control panel (Team Memory Control) and the Knowledge Service (KS).

- **Panel**: the console for managing teams / Agents / Knowledge resources
- **KS**: the Wiki / Code Graph knowledge service that Agents call through tools

The image is published on Docker Hub: [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (pulling `latest` is recommended).

---

## Before you start

### 1. Instance config file

After buying a Memory instance in the cloud you get an **instance ID**, a **Gateway address** and an **API key**. Put them in a JSON file (for example `metadata-instances.json`):

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "My Memory instance",
      "gateway_endpoint": "https://api.weaverai.example.com",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

Set `gateway_endpoint` to the Gateway address the console gave you (for example `https://api.weaverai.example.com` or your WeaverAI Platform URL). For several instances, add more objects to the `instances` array.

### 2. KS externally reachable address

KS has to expose an address that Agents (and the cloud Gateway) can use to reach the KS tools endpoints. This address **must be reachable from outside** (not `127.0.0.1` / `localhost`) and **must include** `/v3`.

For example, if the host's public/internal IP is `10.2.3.4` and port `8424` is mapped:

`http://10.2.3.4:8424/v3`

### 3. LLM proxy address

KS features such as Wiki ingest and summaries call an LLM; by default they go through the LLM forwarding that Memory provides.

`KNOWLEDGE_LLM_PROXY_BASE_URL` is **the same address** as `gateway_endpoint` above: the Gateway address from the Memory console (for example `https://api.weaverai.example.com` or `https://weaverai.platform.weaversoft.io`).

To use your own LLM endpoint instead, see [Custom mode](#custom-mode-direct-llm-no-proxy) below.

---

## Quick start

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=https://api.weaverai.example.com \
  agentmemory/memory-hub:latest
```

> Replace `/path/to/metadata-instances.json`, `10.2.3.4` (the KS external address) and `KNOWLEDGE_LLM_PROXY_BASE_URL` (same as `gateway_endpoint`, the real Gateway address from the console) with your own values.

### Required settings (only these 3)

| Setting | How | Description |
| --- | --- | --- |
| instance config | mount `metadata-instances.json` | ID, Gateway address and API key of the cloud Memory instance |
| KS external address | `KNOWLEDGE_PUBLIC_BASE_URL` | address where KS is reachable from outside; **must include** `/v3` |
| LLM proxy address | `KNOWLEDGE_LLM_PROXY_BASE_URL` | same as `gateway_endpoint`: the Gateway address from the Memory console |

You must provide these 3; everything else has a built-in default in the image and can be adjusted as needed.

---

## Optional settings

All of these have built-in defaults and work without being set. Override them as needed.

### LLM

| Environment variable | Default | Description |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | LLM protocol: `openai` uses `/chat/completions`, `anthropic` uses `/messages` |
| `LLM_MODEL` | `Memory-Model` | model ID, passed through to the proxy/TokenHub |
| `LLM_MODE` | `proxy` | `proxy`: use the Memory Gateway LLM forwarding; `custom`: call your own endpoint directly |
| `LLM_MAX_TOKENS` | `32768` | maximum output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `1200000` | LLM call timeout in ms (20 minutes; reasoning models need a long time) |
| `LLM_API_KEY` | empty | required only when `LLM_MODE=custom` |
| `LLM_BASE_URL` | empty | required only when `LLM_MODE=custom`, e.g. `https://api.openai.com/v1` |

**Protocol and model must match**:

| Protocol | Models | Endpoint |
| --- | --- | --- |
| `openai` (default) | `Memory-Model`, `deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`, `claude-sonnet-4-5`, etc. | `/messages` |

When you switch models, switch the protocol with it:

```bash
# Default (OpenAI protocol + Memory-Model)
# nothing to configure; this is the image default

# Switch to an Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

### Network and storage

| Environment variable | Default | Description |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel port |
| `KNOWLEDGE_PORT` | `8424` | KS port |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS data directory (SQLite, git clones, wiki files, logs) |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite database path |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | root address KS calls back on the Panel when an ingest finishes (loopback inside the container; usually no need to change) |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | timeout for Panel → KS requests |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | timeout for Panel → remote Gateway requests |
| `REMOTE_INSTANCE_PROXY_URL` | empty | base URL shown on the Panel UI's "client connection" card. In the open-source local deploy, where core and proxy run separately, set the proxy's external address (e.g. `http://host.docker.internal:8096`) so the CodeBuddy/Claude Code connection address the Panel UI copies points at the proxy. Empty keeps the old behaviour: the UI falls back to `gateway_endpoint`. **Panel backend → Kernel forwarding always uses `REMOTE_INSTANCE_URL` and has nothing to do with this variable.** (Ignored when `metadata-instances.json` is mounted; add a `proxy_endpoint` field in the JSON instead) |
| `KNOWLEDGE_GIT_AUTH_URL_PREFIX` / `_USERNAME` / `_TOKEN` | empty | server-wide credentials for importing private git repos; the token turns it on (see `deploy/global-images/README.md`) |

### TLS certificates

Public certificates normally need nothing extra. When the LLM proxy or Gateway uses HTTPS with a certificate the container doesn't trust (self-signed, internal CA), there are two options:

**Option A: skip TLS verification (quick tests only, not for production)**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Option B: mount the CA certificate (recommended)**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | not set | `0` skips TLS certificate verification (testing only) |
| `NODE_EXTRA_CA_CERTS` | not set | extra CA certificate path; supported natively by Node.js and read by the AI SDK's fetch too |

### Logs

| Environment variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | log level (`debug` / `info` / `warn` / `error`) |
| `LOG_FORMAT` | `json` | log format (`json` / `text`) |
| `LOG_DIR` | `/data/knowledge/logs` | log file directory |

Logs are written to `${LOG_DIR}/panel.log` and `${LOG_DIR}/knowledge.log`, each rotated to a `.prev` copy on every start, and also go to stdout (visible with `docker logs`).

### Observability (Langfuse)

With all three set, KS reports traces of its LLM calls to Langfuse automatically.

| Environment variable | Default | Description |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | empty | Langfuse address |
| `LANGFUSE_PUBLIC_KEY` | empty | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | empty | Langfuse secret key |

### LLM binding sync

| Environment variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | whether the Panel syncs the KS llm_binding for each instance at startup. Forced to `1` when `LLM_MODE=proxy`; in `custom` mode set `0` so KS uses its global config |

---

## Addresses

| Service | Address |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger docs | `http://localhost:8424/docs` |

---

## Custom mode (direct LLM, no proxy)

If you don't use the Memory Gateway's LLM forwarding, point KS at your own LLM endpoint. `KNOWLEDGE_LLM_PROXY_BASE_URL` is then not needed.

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## Data persistence

| Mount point | Description |
| --- | --- |
| `/data/knowledge` | KS data (SQLite, git clones, wiki files, logs) |

Use a named volume: `-v memory-hub:/data/knowledge` (same name as the container).

---

## FAQ

### Q: How do I reach host services from inside the container?

The cloud Gateway (`KNOWLEDGE_LLM_PROXY_BASE_URL`) is usually reachable directly; no need to change it to a host address. If other services (such as Langfuse) run on the host, use `172.17.0.1` (the docker0 bridge) instead of `localhost`:

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

Or add `--add-host=host.docker.internal:host-gateway` and use `host.docker.internal`.

### Q: Wiki ingest times out?

Reasoning models can need more than 20 minutes for large files:

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 minutes
```

### Q: tools/list returns 404?

`KNOWLEDGE_PUBLIC_BASE_URL` must include the `/v3` prefix. Correct form: `http://host:port/v3`.

### Q: Errors after switching the LLM protocol?

Make sure `LLM_PROTOCOL` and `LLM_MODEL` match:

```bash
# OpenAI model (default)
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

## Build

### Prerequisites

All sources are under the repository root:

```text
memory-weaverai/
├── MemoryPanel/                         # Panel backend + web frontend
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # this recipe
```

### Local single-architecture build (for debugging)

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # default linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # builds directly on an arm64 machine
```

### Publish to Docker Hub (amd64 + arm64)

Tag conventions:

| Tag | Meaning |
| --- | --- |
| `1.0.0-beta.N` | pinned version (use this in docs / for reproducing) |
| `beta` | floating channel: always the latest beta (pushed with every release by default) |
| `latest` | only for stable releases (not pushed by default) |

For the first release push `agentmemory/memory-hub:1.0.0-beta.1` + `agentmemory/memory-hub:beta`.

```bash
cd deploy/panel-knowledge-combined

# 1) Log in to Docker Hub (needs push rights on the agentmemory org)
docker login

# 2) Only scan for secrets + prepare the context (no build)
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) Optional: load amd64 locally first and check the image layers contain no .env / metadata-instances.json
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) Real two-architecture build and push (also tags :beta by default)
VERSION=1.0.0-beta.1 ./publish.sh

# Version tag only, don't move :beta:
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# Tag latest for a stable release (don't enable during beta):
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` does, in order:

1. runs `scripts/secret-scan.sh` on `MemoryPanel` / `MemoryKnowledge`
2. `PREPARE_ONLY=1 ./build.sh` builds the rsync context (excluding `.env*`, `metadata-instances.json`, etc.)
3. scans the context again
4. `docker buildx build --platform linux/amd64,linux/arm64 --push` to `agentmemory/memory-hub:<VERSION>` (also tags `:beta` by default; the local name `team-memory-panel-knowledge` is only used with `PUSH=0` and is never pushed)

Check after pushing:

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# both should show Platform: linux/amd64 and linux/arm64 with the same digest
docker pull agentmemory/memory-hub:beta
```

Environment variable quick reference:

| Variable | Default | Description |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | version tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | repository name |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx targets |
| `BUILDER` | `multiarch` | buildx builder name (created automatically if missing) |
| `DRY_RUN` | `0` | `1` = scan only |
| `PUSH` | `1` | `0` = local `--load`, single architecture |
| `ALSO_BETA` | `1` | `1` = also push the floating `:beta` |
| `ALSO_LATEST` | `0` | `1` = also push `:latest` |
