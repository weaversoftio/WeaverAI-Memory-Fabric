# MemoryKnowledge (Knowledge Service)

Part of **WeaverAI Memory Fabric**. This directory is the monorepo's **Knowledge Service (KS)**: the user-facing Wiki + Code-Graph engine.  
The control plane lives in [`../MemoryPanel`](../MemoryPanel/).

Default port **8421**, API prefix **`/v3`**.

## What it does

| Capability | Description |
| --- | --- |
| **LLM-Wiki** | upload/fetch documents → the LLM extracts structured pages → FTS5 full-text search + knowledge graph |
| **Code-Graph** | `git clone` a repository → CodeGraph index (symbols, calls, file tree) → exploration queries |
| **Auto-Sync** (optional) | periodically scans code-graphs; a FIFO queue + worker pool pulls git updates and rebuilds the index. Off by default; see `docs/data-flow.md` §9. |
| **Private repositories** (optional) | server-wide git credentials via `KNOWLEDGE_GIT_AUTH_URL_PREFIX` / `_USERNAME` / `_TOKEN`; the token turns it on and is sent as an HTTP header, never stored in repo URLs |
| **Tools** | `POST /v3/tools/list`, `/v3/tools/call`, for Agents / the Kernel to discover and call |
| **Status callback** | after an ingest/sync finishes, calls back the Panel (`TMC_CALLBACK_URL`), which then writes the remote meta / knowledge |

`pnpm dev` alone starts the service; in the product flow the Panel must push the `llm_binding`, receive callbacks and write the remote metadata.

## Source layout

```text
MemoryKnowledge/
├── src/
│   ├── server.ts           # Hono entry: mounts routes, Swagger, starts listening
│   ├── module.ts           # wires store / wiki / code-graph / queues / recovery
│   ├── config.ts           # environment variables
│   ├── callback.ts         # → Panel status-callback
│   ├── telemetry.ts        # optional Langfuse (off when no KEY is set)
│   ├── routes/             # wiki / code-graph / tools / llm-binding / health
│   ├── engines/
│   │   ├── wiki/           # ingest-v2, indexing, graph search
│   │   └── code/           # CodeGraph bridge
│   ├── store/              # SQLite (Drizzle) + build queue + llm_binding
│   ├── source-fetcher/     # Git fetching
│   ├── mcp/                # MCP stdio (forwards to the local HTTP API)
│   ├── db/                 # schema / client
│   └── middleware/
├── docs/                   # design and API details
├── Dockerfile              # standalone KS image (optional)
└── docker-compose.yml      # run the KS container locally with one command (optional)
```

## Running locally

For production or integration testing with the **combined Panel + KS image**, pull [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (usage in [`../deploy/panel-knowledge-combined/README.md`](../deploy/panel-knowledge-combined/README.md)). To run just this service from source:

```bash
cd MemoryKnowledge
pnpm install --ignore-workspace
cp .env.example .env
# edit .env (see below)
pnpm dev
```

```bash
curl -s http://127.0.0.1:8421/health
# Swagger: http://127.0.0.1:8421/docs
```

When running together with the Panel (Panel default `8123`), the KS `.env` needs at least:

```dotenv
PORT=8421
API_PREFIX=/v3
KNOWLEDGE_DATA_DIR=./data
KNOWLEDGE_DB_PATH=./data/knowledge.db
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3   # reachable by Agents, must include /v3
TMC_CALLBACK_URL=http://127.0.0.1:8123               # Panel root address, no callback path
LLM_MODE=proxy
LLM_MODEL=Memory-Model
```

On the Panel side (the Panel's own `.env`, not the KS one):

```dotenv
KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421
```

| Variable | Read by | Includes `/v3`? |
| --- | --- | --- |
| `KNOWLEDGE_PUBLIC_BASE_URL` | KS → written into the resource's `service_url` | yes |
| Panel `KNOWLEDGE_SERVICE_URL` | Panel → calls the KS management API | no |
| `TMC_CALLBACK_URL` | KS → calls back the Panel | no (root only) |

`LLM_MODE=proxy` (default): the Wiki uses the `llm_binding` the Panel pushes per `x-wamf-service-id`; no local proxy needed.  
`LLM_MODE=custom`: set `LLM_API_KEY` / `LLM_BASE_URL` in `.env` (and optionally `LLM_PROTOCOL=anthropic`).

## Common commands

```bash
pnpm dev          # HTTP API (tsx hot reload)
pnpm dev:mcp      # MCP stdio (separate terminal; needs the HTTP server running)
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
```

## Optional: ClickHouse tool-call logging

Off by default. With the variables below set, the Knowledge Service writes `POST /v3/tools/call` into a `tool_call_logs` table compatible with Memory/Skill. The table is created idempotently at startup; failed batch writes or table creation never block business requests.

```dotenv
KNOWLEDGE_CLICKHOUSE_ENABLED=true
KNOWLEDGE_CLICKHOUSE_URL=http://clickhouse.example.com:8123
KNOWLEDGE_CLICKHOUSE_DATABASE=default
KNOWLEDGE_CLICKHOUSE_TABLE=tool_call_logs
KNOWLEDGE_CLICKHOUSE_USER=knowledge_writer
KNOWLEDGE_CLICKHOUSE_PASSWORD=              # injected from the environment only, never in code
```

Optional tuning is in `.env.example`. If the caller sends `x-conversation-id`, `x-wamf-user-id`, `x-wamf-team-id`, `x-wamf-agent-id`, `x-wamf-agent-source`, `x-wamf-space-id` or `x-wamf-turn-seq`, those dimensions are stored too; missing ones leave their columns empty. Request bodies are recursively redacted and truncated to 512 bytes.

## Optional: Langfuse

Set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (and optionally `LANGFUSE_BASE_URL`) to report Wiki LLM calls.  
Without them tracing is off and nothing else is affected.
