# WAMF global images: local deployment

Scripts to run the three global images locally — `memory-core` + `memory-hub` + `proxy`. Each can run on its own, or all three start with one command.

## Components and ports

| Component | Container | Image (public on Docker Hub) | Host port | Purpose |
|---|---|---|---|---|
| **memory-core** | `wamf-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | Kernel gateway: memory read/write, auth, skill/RAG data plane |
| **memory-hub**  | `wamf-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | Combined image: admin panel (Panel) + knowledge service (Knowledge) |
| **proxy**       | `wamf-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM request proxy, the API entry point for coding agents |

> The `agentmemory/*` images on Docker Hub are upstream builds, not this repository's code. Set
> `MEMORY_CORE_IMAGE`, `MEMORY_HUB_IMAGE` and `PROXY_IMAGE` in `.env` to images built from this repo
> (e.g. `zot.platform.weaversoft.io/apps/agent-memory-core:<commit>`); the scripts refuse to start until you do.

## Requirements

- macOS / Linux, or Windows with Git Bash
- Docker (Docker Desktop / colima / OrbStack)
- `bash` 4+ (macOS's built-in 3.2 also works)

## Quick start

```bash
cd Agent-Memory/deploy/global-images

# One command: copy .env → fill in the LLM interactively → check the connection → start all three
./start-all.sh
```

`start-all.sh` is **interactive**. When you run it, it:

1. copies `.env.example` to `.env` if `.env` doesn't exist (no manual `cp` needed)
2. asks for the two LLM groups (**Enter = keep the current default**):
   - `memory group`: `BASE_URL` / `API_KEY` / `MODEL` (protocol defaults to `openai`)
   - `proxy group`: first asks "Should the proxy use the same LLM settings as memory?"; if yes, it's skipped
3. **checks the LLM connection right away**; if it fails you're asked again, until it passes
4. **writes the values back to `.env`** (reused by default next time)
5. starts all three once the check passes

> To skip the questions and just use `.env`: run `cp .env.example .env` yourself, fill in the LLM settings,
> then run `./start-all.sh` and press Enter at every prompt (the defaults are the values from `.env`).

### MongoDB storage backend (experimental, optional)

The default storage is still **sqlite** (no dependencies, data in a container volume). The MongoDB data plane is **experimental**,
off by default, and not recommended as the production default. When on, it stores L0/L1/profile/skill documents with mongot
native BM25 search, and metadata goes to Mongo too by default:

```bash
./start-all-mongo.sh    # same flow as start-all.sh; writes MEMORY_CORE_STORE_MODE=mongodb to .env
```

- The script writes `MEMORY_CORE_STORE_MODE=mongodb` into `.env`, so later `./start-all.sh` runs
  also stay on MongoDB instead of silently falling back to sqlite. To go back to sqlite, comment that line out or set it to
  `sqlite`, then run `./start-all.sh`;
- Without `MONGODB_ENDPOINT`, the script starts a local `mongodb-atlas-local` container
  (mongod + mongot in one — **not** cloud Atlas; data persisted in the `mongo-local-*` volumes,
  which `stop-all.sh --purge` also cleans up);
- To use an external Mongo (cloud Atlas / a self-hosted replica set with mongot), set
  `MONGODB_ENDPOINT` in `.env`;
- **Switching storage backends doesn't migrate existing data.** sqlite lives in the `MEMORY_CORE_VOLUME` volume, mongo
  in the `mongo-local-*` volumes (or the external instance); after switching, the old data stays in the old backend. For now,
  back it up and migrate it by hand; an official migration tool is planned. L2/L3 files live in the
  `MEMORY_CORE_VOLUME` volume in both modes.

### Dry-run check (optional)

`verify.sh` can still be used on its own; it checks the environment without starting containers:

```bash
./verify.sh              # full check by default (including the LLM connection pre-check)
./verify.sh --skip-llm   # skip the LLM check (offline)
```

## LLM connection pre-check

`verify.sh` checks both LLM groups by default (`--skip-llm` turns this off):

- **OpenAI-compatible protocol**: `GET {base}/models` — only verifies the API key + URL and **uses no tokens**
- **Anthropic protocol**: `POST {base}/v1/messages` with a minimal `max_tokens=1` message, using ≤ 10 tokens
- The **memory group** and **proxy group** are checked separately; if both are identical, the second check is skipped
- **If the containers are running**, curl is also run once from inside the container, to check "container → LLM" reachability (in some corporate proxy / DNS-isolated setups the host can reach the LLM but the container can't)

A failing example:

```
[error] memory LLM API key is invalid (HTTP 401): https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

— a wrong API key, URL or model name is caught before startup, instead of surfacing as a 401 during wiki ingest or chat.

When startup is done:

- Panel UI: <http://localhost:8125/>
- Knowledge API: <http://localhost:8424/v3/>
- Knowledge Swagger: <http://localhost:8424/docs>
- Memory Gateway: <http://localhost:8420/>
- Proxy: <http://localhost:8096/>

## Two independent groups of settings

**This is the core of the script design** — the memory group's and the proxy group's LLMs are completely independent and can point to different providers / models.

### memory group (used by memory-core + memory-hub)

Kernel memory embed/summarize and knowledge's wiki ingest / summaries use this group.

| Variable | Description | Example |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI-compatible base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | API key for that endpoint | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | Model ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` or `anthropic`, default `openai` | `openai` |

### proxy group (used by the proxy)

The proxy forwards user requests to this endpoint.

| Variable | Description | Example |
|---|---|---|
| `PROXY_UPSTREAM_URL` | Base URL to forward to | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | API key for forwarding | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | Model ID users see | `deepseek-chat` |

> Both groups can have the same values (pointing at the same LLM) or be completely different: e.g. a cheap model for embedding in the memory group and a strong model for the main conversation in the proxy group.
>
> Claude Code speaks the Anthropic format and the proxy forwards requests unchanged, so for Claude Code the proxy group must point at an Anthropic-compatible endpoint — e.g. a LiteLLM gateway (`http://host.docker.internal:4000/v1` for a LiteLLM running on the host), which also translates to OpenAI models.

When settings are missing, the script **lists every missing one at once before starting** and exits with code 1, instead of failing halfway through.

## Memory prompt mode (chat / code)

memory-core switches the prompt family of the L1/L2/L3 pipeline with `MEMORY_PROMPT_MODE`:

| Mode | `.env` value | Extracts | L3 output | Fits |
|---|---|---|---|---|
| **code** (default) | `MEMORY_PROMPT_MODE=code` | project facts / tasks / decisions / SOPs / taboos | Team Operating Doctrine | coding agents, team collaboration, engineering projects |
| chat | `MEMORY_PROMPT_MODE=chat` | persona / episodic / instruction | persona.md (personal profile) | personal assistants, chit-chat, teaching |

> **Note**: in `code` mode pure small talk may extract 0 memories (the LLM finds no engineering content worth keeping). If L1 never produces anything, first check that `MEMORY_PROMPT_MODE` matches how the conversations are actually used.

## Internal credentials (read before production)

The three services authenticate to each other with `MEMORY_CORE_GATEWAY_API_KEY`, and the first start also creates a
`system_admin` account through `init-admin`. For a **zero-config local setup**, the script defaults are:

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | Bearer for memory-hub / proxy → memory-core |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | Username of the initialised system_admin |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | Login key of that admin user |
| `KNOWLEDGE_SERVICE_KEY` | **random value, generated automatically** | Panel ↔ Knowledge service Bearer (required on write/admin endpoints) |

> `KNOWLEDGE_SERVICE_KEY` has no fixed default: on first start the script generates a random `ks-svc-*` string
> and writes it back to `.env` (reused across restarts), and injects the same value into the memory-hub container twice —
> `KNOWLEDGE_SERVICE_KEY` (checked by Knowledge) + `KNOWLEDGE_AUTH_TOKEN` (sent by Panel).
> To distribute it yourself (multi-machine / external orchestration), set it explicitly in `.env`; the script respects an existing value.

> These three defaults are only for running things on your own machine. **Before production / shared testing / any public exposure, replace them with long random strings**,
> otherwise anyone who reaches the ports gets system_admin rights.
>
> Uncomment the three lines in `.env` and override them (`_lib.sh` uses `require_vars` to
> check the other required settings; these three have fallback defaults, so the script prints a `[warn]` at startup reminding you to change them).

## Using each component on its own

The three scripts can run separately, for debugging or when you only need part of the stack:

```bash
./start-memory-core.sh  # only the kernel gateway (8420)
./start-memory-hub.sh   # only panel + knowledge (8125 + 8424); needs the MEMORY_LLM_* settings
./start-proxy.sh        # only the proxy (8096); needs the PROXY_UPSTREAM_* settings
```

Dependencies:

- **memory-core**: no outside dependencies, can start on its own
- **memory-hub**: can start on its own (LLM_MODE=custom connects to the LLM directly), but the knowledge service's RAG calls to memory-core fail → start memory-core first
- **proxy**: can start on its own (falls back to plain passthrough when cost-guard is unavailable), but auth / wamf memory / skill injection need memory-core to work

When a component is missing, the scripts `warn` about it but don't block.

## Data persistence

- `wamf-memory-core-data` (named volume) → memory-core's SQLite / memory data
- `wamf-panel-data` (named volume) → the knowledge service's SQLite / git clones / wiki files in memory-hub

Data stays until you `docker volume rm` it. Rename the volumes with `MEMORY_CORE_VOLUME` / `PANEL_VOLUME` in `.env`.

## Stop / clean up

```bash
./stop-all.sh            # stop the containers, keep the volumes (data is still there next time)
./stop-all.sh --purge    # stop the containers + delete the volumes + delete the network (full cleanup)
```

## Logs

```bash
docker logs -f wamf-memory-core
docker logs -f wamf-memory-hub
docker logs -f wamf-proxy
```

memory-hub runs two processes (panel + knowledge); inside the container their logs are `/data/knowledge/logs/panel.log` and `.../knowledge.log`.

## Port conflicts

If `8125` / `8420` / `8424` / `8096` clash with services already running locally, change them in `.env`:

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# the externally reachable knowledge address must follow KNOWLEDGE_PORT
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## Using the proxy as a coding agent's API base

For example, Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="$(cat .admin-key)"
# OpenAI-protocol clients are similar: OPENAI_BASE_URL=http://localhost:8096/<agent>/default/v1
```

The panel's "client connection" card automatically uses the host's LAN IP + `PROXY_PORT` (e.g.
`http://192.168.1.100:8096/codebuddy/default`), so other people's machines can copy it and connect directly.
It comes from `MEMORY_HUB_PROXY_PUBLIC_URL` (when unset, the script detects it with `hostname -I` / macOS `ipconfig getifaddr en0`,
falling back to `localhost`), injected into `metadata-instances.json.proxy_endpoint` in memory-hub.
The Panel backend → Kernel forwarding is not affected by this variable (it always uses `REMOTE_INSTANCE_URL` → memory-core:8420).
If the detected address is wrong (several network interfaces / public domain / a reverse proxy in front), set
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<actual-address>:8096` in `.env`. To make the UI card use the old behaviour (falling back to
gateway_endpoint), set `MEMORY_HUB_PROXY_PUBLIC_URL` to an empty string.

`start-all.sh` turns on the proxy's full pipeline (auth + sessionInit + wamf memory injection) by default; set `PROXY_FULL_STACK=0` for plain forwarding. For the full set of proxy options, see `MemoryProxy/config.example.yaml`.

## FAQ

**Q: `./start-all.sh` hangs in wait_healthy?**
The image may still be downloading. Pull it once by hand with `docker pull <IMAGE>`, then rerun the script.

**Q: memory-hub is up but the panel won't open?**

Check that `KNOWLEDGE_PUBLIC_BASE_URL` in `.env` includes `/v3` — without `/v3` the panel errors.

**Q: the proxy returns 401 when forwarding?**
`PROXY_UPSTREAM_API_KEY` is invalid or `PROXY_UPSTREAM_URL` is wrong. Check the error with `docker logs wamf-proxy`.

**Q: how do containers reach other services on the host (Ollama, Langfuse, LiteLLM, etc.)?**
The scripts already pass `--add-host=host.docker.internal:host-gateway`. Inside a container, use `http://host.docker.internal:<port>`.
