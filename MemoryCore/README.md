# MemoryCore

MemoryCore is the **memory and metadata core** of **WeaverAI Memory Fabric**. It provides unified storage and APIs for three types of data:

- **Memory**: L0 conversations, L1 atomic memories, L2 scenarios, and L3 profiles.
- **Knowledge metadata**: identifiers, types, status, associations, and service locations for Wiki, Code Graph, and other knowledge sources.
- **Asset management metadata**: users, teams, Agents, tasks, Skills, knowledge assets, memberships, ownership, and access relationships.

MemoryCore runs independently and exposes these capabilities through an HTTP Gateway. OpenClaw, Hermes, and custom applications connect through lightweight adapters or SDKs. An Agent is a caller and a managed metadata entity; MemoryCore does not host, schedule, or execute the Agent itself.

> MemoryCore stores knowledge metadata, not knowledge content. Wiki parsing, code graph construction, indexing, and content retrieval are provided by `MemoryKnowledge/`.

## Core capabilities

- **Memory storage and processing**: records L0 conversations and maintains L1 atomic memories, L2 scenarios, and L3 profiles.
- **Memory recall**: supports keyword, embedding, and hybrid retrieval; BM25 remains available without an embedding provider.
- **Knowledge metadata registry**: registers knowledge sources and tracks their identifiers, types, status, associations, and service locations.
- **Asset metadata management**: manages users, teams, Agents, tasks, Skills, knowledge assets, memberships, ownership, and access relationships.
- **Skill Memory**: supports Skill creation, versions, resources, search, routing, and conversation-driven extraction.
- **Unified access**: provides HTTP APIs and TypeScript/Python SDKs for adapters and applications.

## Architecture

```text
OpenClaw / Hermes / Custom Application
                  │
                  │ HTTP API / SDK
                  ▼
          MemoryCore Gateway :8420
          ├─ Memory
          │  └─ L0 / L1 / L2 / L3
          ├─ Knowledge Metadata
          ├─ Asset Management Metadata
          └─ SQLite + local files

MemoryKnowledge
      └─ knowledge parsing / indexing / retrieval
```

## Runtime

MemoryCore is distributed as a standalone runtime for local development, single-node deployment, and Agent sidecars:

- Listens on `127.0.0.1:8420` by default.
- Uses SQLite, local files, and in-process state.
- Requires no external service other than an LLM API.
- Disables remote embeddings by default and uses BM25 retrieval.
- Stores data under `~/.weaverai-memory-fabric/memory-wamf` by default.

## Requirements

- Node.js `>= 22.16.0`
- npm
- An OpenAI-compatible LLM API. Read-only queries may not invoke an LLM, but memory extraction and aggregation require valid credentials.

## Quick start

### 1. Install and build

```bash
cd MemoryCore
npm install
npm run build
```

### 2. Start the Standalone Gateway

```bash
export WAMF_GATEWAY_CONFIG="$PWD/wamf-gateway.standalone.yaml"
export WAMF_LLM_API_KEY="your-api-key"
export WAMF_LLM_BASE_URL="https://api.openai.com/v1"
export WAMF_LLM_MODEL="gpt-4o-mini"

node --import tsx src/gateway/server.ts
```

Check the Gateway after startup:

```bash
curl http://127.0.0.1:8420/health
```

To accept traffic from another machine or container, configure both the bind address and authentication:

```bash
export WAMF_GATEWAY_HOST="0.0.0.0"
export WAMF_GATEWAY_API_KEY="replace-with-a-strong-random-token"
```

Once authentication is enabled, every endpoint except `/health` and CORS preflight requires:

```text
Authorization: Bearer <WAMF_GATEWAY_API_KEY>
x-wamf-service-id: <memory-instance-id>
```

## Upgrading from Older Versions

If upgrading from v1.x or v0.x (data format v2) to v2.0.0+ (data format v3), run the data migration script **before starting the new Gateway**.

> ⚠️ Back up your entire data directory before migration.

```bash
# Dry-run inspection
python scripts/migrate-v2-to-v3/v2-to-v3-migrate.py ~/.weaverai-memory-fabric/memory-wamf --dry-run

# Run migration
python scripts/migrate-v2-to-v3/v2-to-v3-migrate.py ~/.weaverai-memory-fabric/memory-wamf
```

See [migration script documentation](scripts/migrate-v2-to-v3/README.md) for details.

## Docker

Build from the `MemoryCore/` directory:

```bash
docker build -t memory-core:local .
```

Run a Standalone container:

```bash
docker run --rm \
  -p 8420:8420 \
  -e WAMF_LLM_API_KEY="your-api-key" \
  -e WAMF_GATEWAY_API_KEY="replace-with-a-strong-random-token" \
  -v "$PWD/wamf-gateway.standalone.yaml:/data/config/wamf-gateway.yaml:ro" \
  -v memory-core-data:/data/wamf-memory \
  memory-core:local
```

Inject credentials through environment variables or a secret manager. Do not store API keys or other credentials in images or committed configuration files.

## Agent integration

### OpenClaw

Use the lightweight client adapter under `openclaw-plugin/`. It connects to an existing MemoryCore Gateway and does not run a second memory pipeline inside the OpenClaw process.

Run from the repository root:

```bash
bash MemoryCore/scripts/install-openclaw-plugin.sh
```

Common connection settings:

```text
WAMF_MEMORY_ENDPOINT=http://127.0.0.1:8420
WAMF_MEMORY_API_KEY=<the same API key configured on the Gateway>
WAMF_MEMORY_INSTANCE_ID=default
```

### Hermes

`hermes-plugin/` provides the Hermes Memory Provider. It follows the same adapter model and uses the Gateway for conversation capture and memory recall.

### Custom Agents

Custom runtimes can use the SDKs included in this repository:

- `../sdk/memory-core/typescript/`
- `../sdk/memory-core/python/`

An adapter generally has three responsibilities:

1. Write completed turns or sessions to L0.
2. Recall L1/L2/L3 before constructing the next prompt.
3. Inject recalled results into the Agent as bounded, clearly labeled context.

## API surface

| API | Purpose | Status |
| --- | --- | --- |
| `/capture`, `/recall`, `/search/*` | Early Gateway compatibility endpoints | Compatibility |
| `/v2/conversation/*` | L0 write, query, search, delete, and count | Stable |
| `/v2/atomic/*` | L1 query, search, update, delete, and count | Stable |
| `/v2/scenario/*`, `/v2/core/*` | L2/L3 read and write | Stable |
| `/v3/conversation/*`, `/v3/atomic/*`, `/v3/scenario/*`, `/v3/core/*` | Strongly isolated L0–L3 data plane | Recommended for new integrations |
| `/v3/skill/*` | Skill management, search, versions, resources, and extraction | Stable |
| `/v3/meta/*` | User, Team, Agent, Task, Asset, and access relationships | Management plane |
| `/v3/knowledge/*` | Knowledge asset metadata registration | Management plane |
| `/health` | Health check | Public |

The v3 memory data plane requires `team_id`, `agent_id`, and `user_id`. Supply them in the request body or the corresponding `x-wamf-*` headers. `session_id` is optional and narrows operations to a session when provided.

## Custom prompts and generation provenance

Each Memory Instance can have up to 500 custom prompts, each at most 10,000 Unicode characters. A prompt and its target bindings are stored separately; an update keeps the same `memory_prompt_id` and does `version += 1`, and new generation tasks with an existing binding use the latest version.

Target priority:

```text
Agent > Team > Instance > built-in system prompt
```

- An Agent is identified by `team_id + agent_id`.
- When no custom prompt matches, L1/L2/L3 use the current built-in prompts unchanged.
- When one matches, only the customer's memory strategy is appended; the fixed output protocols (L1 JSON, L2 Scene Markdown, L3 Persona/Doctrine) cannot be changed.
- Deleting a prompt removes its bindings; at runtime it falls back to the next level automatically.

Main endpoints:

```text
POST /v3/memory-prompt/create
GET  /v3/memory-prompt/get
POST /v3/memory-prompt/update
POST /v3/memory-prompt/delete
POST /v3/memory-prompt/set
GET  /v3/memory-prompt/log
GET  /v3/memory-generation-log/list
GET  /v3/memory-generation-log/get
```

Create a prompt:

```bash
curl -sS -X POST http://127.0.0.1:8420/v3/memory-prompt/create \
  -H "Authorization: Bearer ${WAMF_GATEWAY_API_KEY}" \
  -H "x-wamf-service-id: local-memory" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "architecture-decisions",
    "layer": "l1",
    "prompt": "Focus on extracting architecture decisions, compatibility constraints, risks and reusable methods."
  }'
```

Locally, when `WAMF_GATEWAY_API_KEY` is not set and the gateway only listens on loopback, `Authorization` can be omitted; `x-wamf-service-id` is always required.

Generation logs don't store the custom prompt text, only the prompt ID, version, source and SHA-256. Query by Memory ID:

```bash
curl -sS -G http://127.0.0.1:8420/v3/memory-generation-log/get \
  -H "Authorization: Bearer ${WAMF_GATEWAY_API_KEY}" \
  -H "x-wamf-service-id: local-memory" \
  --data-urlencode "memory_id=<memory-id>" \
  --data-urlencode "layer=l1"
```

The TypeScript SDK exports `MemoryPromptClient` and `MemoryGenerationLogClient`; the Python SDK provides both sync and async clients.

## Configuration

The Gateway resolves configuration in this order:

1. A YAML or JSON file specified by `WAMF_GATEWAY_CONFIG`.
2. `wamf-gateway.yaml` or `wamf-gateway.json` in the current directory.
3. `wamf-gateway.yaml` or `wamf-gateway.json` in the data directory.
4. Environment variables and built-in defaults.

Environment variables override file configuration. Common settings:

| Environment variable | Default | Description |
| --- | --- | --- |
| `WAMF_GATEWAY_CONFIG` | Auto-discovered | Configuration file path |
| `WAMF_GATEWAY_HOST` | `127.0.0.1` | Gateway bind address |
| `WAMF_GATEWAY_PORT` | `8420` | Gateway port |
| `WAMF_GATEWAY_API_KEY` | Unset | HTTP Bearer authentication; required for non-loopback binding |
| `WAMF_CORS_ORIGINS` | Empty | Comma-separated allowed origins |
| `WAMF_DATA_DIR` | `~/.weaverai-memory-fabric/memory-wamf` | Local data directory |
| `WAMF_LLM_API_KEY` | Empty | LLM API key |
| `WAMF_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API URL |
| `WAMF_LLM_MODEL` | `gpt-4o` | LLM model |
| `WAMF_SKILL_ENABLED` | File configuration | Force-enable the Skill module |

Configuration templates:

- `wamf-gateway.standalone.yaml`: minimal single-node Memory configuration.
- `wamf-gateway.yaml`: default Standalone + Skill configuration.
- `wamf-gateway.proxy.yaml`: LLM access through an OpenAI-compatible proxy.

## Storage and isolation

- Memory and metadata are stored in SQLite.
- Files and large objects are stored in the local data directory.
- Pipeline state is maintained in process.
- BM25 works without an external embedding service; an OpenAI-compatible embedding API can be configured when needed.

Every business request should identify its memory instance through `x-wamf-service-id`. New adapters should use the v3 data plane and always provide Team, Agent, and User isolation dimensions.

## Project layout

```text
MemoryCore/
├── src/core/              L0–L3 Memory, Skill, Store, and Storage abstractions
├── src/gateway/           HTTP Gateway and v2/v3 routers
├── src/services/          Pipeline scanner, workers, and scheduling services
├── openclaw-plugin/       Lightweight OpenClaw client adapter
├── hermes-plugin/         Hermes Memory Provider
├── scripts/               Installation, build, migration, and operations tools
├── Dockerfile             MemoryCore Gateway image
├── wamf-gateway*.yaml     Gateway configuration templates
└── package.json           Node.js package metadata and commands
```

## Local data utilities

```bash
npm run read-local-memory
npm run seed-v2
```

## Security recommendations

- Always configure `WAMF_GATEWAY_API_KEY` when binding to a non-loopback address.
- CORS is disabled by default. Allow only explicitly trusted origins and do not use `*` in production.
- Inject secrets through environment variables or a secret manager.
- Do not commit `.env` files, databases, logs, exports, or real service configurations.
- Validate instance and Team/User/Agent ownership on every request to prevent cross-tenant access.

## License

MIT
