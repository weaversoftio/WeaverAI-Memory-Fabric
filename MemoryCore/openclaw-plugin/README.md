# OpenClaw Adapter for WeaverAI Memory Fabric (v3)

English

This directory is the **OpenClaw client adapter** for Memory Gateway **`/v3/*`**. It does not run extraction, indexing, scene generation, or persona generation. It connects to an already-running Memory Gateway and uses the npm TypeScript SDK to capture conversations, recall memories, and expose memory tools to the Agent.

| Item | Value |
|------|--------|
| Plugin ID | `memory-weaverai-client` (same historical ID; implementation is v3) |
| SDK | [`@weaversoft/memory-fabric-sdk-ts-v2@1.0.0-beta.2`](https://www.npmjs.com/package/@weaversoft/memory-fabric-sdk-ts-v2/v/1.0.0-beta.2) (npm; root = v3) |
| Data plane | `MemoryClient` → `/v3/*` + isolation (`teamId` / `agentId` / `userId`) |
| File read | Tool `wamf_read_file` via `readScenario()` / `readCore()` (served by the Gateway) |
| Not included | Offload / Context Engine |

For local standalone Gateway, use `http://127.0.0.1:8420` with `apiKey = "local"`, `instanceId = "default"`, and isolation triple `"default"` (aligned with `DEFAULT_ISOLATION_ID`). If the Gateway enables `WAMF_GATEWAY_API_KEY`, set `server.apiKey` to the same value.

More design detail: `../docs/design/2026-07-20-v3-plugin-install-dual-mode-design.md`, `docs/architecture.md`.

## Architecture

```text
OpenClaw runtime
  └─ memory-weaverai-client plugin
       ├─ hooks/capture.ts             agent_end → addConversation (L0, /v3)
       ├─ hooks/recall.ts              before_prompt_build → search + prompt injection
       ├─ tools/memory-search.ts       wamf_memory_search → searchAtomic (L1)
       ├─ tools/conversation-search.ts wamf_conversation_search → searchConversation (L0)
       └─ tools/ (file read)           wamf_read_file → readScenario / readCore (L2/L3)
            │
            ▼
       @weaversoft/memory-fabric-sdk-ts-v2
            │  MemoryClient            →  HTTP /v3/*
            ▼
       WeaverAI Memory Fabric Gateway (:8420 standalone, or remote service)
```

## Tools

| Tool | Purpose |
|------|---------|
| `wamf_memory_search` | Search L1 structured memories |
| `wamf_conversation_search` | Search L0 conversation history |
| `wamf_read_file` | Read memory files by relative path (`scene_blocks/…`, `persona.md`, …) |

## Dual mode (Gateway deployment)

| Mode | Meaning |
|------|---------|
| `local` | Gateway at `127.0.0.1:8420`, placeholder auth + isolation |
| `server` | Remote Gateway; real API Key + instance + isolation required |

Both modes use the **same npm SDK** (`memory-sdk-ts-v2`). “Online/offline” here means Gateway deployment (local vs server), not how the SDK package is obtained.

## Quick Start

Recommended: from `MemoryCore/`, run the v3 installer (wrapper around `npm install` for the SDK + plugin build + `openclaw plugins install -l` + config write):

```bash
# Local Gateway (defaults)
bash scripts/install-openclaw-plugin.sh

# Remote Gateway (strict)
MEMORY_INSTALL_MODE=server \
  WAMF_MEMORY_ENDPOINT="https://memory.example.com" \
  WAMF_MEMORY_API_KEY="<instance-api-key>" \
  WAMF_MEMORY_INSTANCE_ID="<instance-id>" \
  WAMF_MEMORY_TEAM_ID="team-..." \
  WAMF_MEMORY_AGENT_ID="agent-..." \
  WAMF_MEMORY_USER_ID="user-..." \
  bash scripts/install-openclaw-plugin.sh
```

The script installs/builds this plugin (`npm install` pulls the SDK from the registry), runs `openclaw plugins install -l`, and updates `~/.openclaw/openclaw.json`: `plugins.slots.memory = "memory-weaverai-client"`, enables the entry, and writes `server` (including isolation), `recall`, and `capture`. On **OpenClaw >= 2026.4.24** it also writes `hooks.allowPromptInjection` / `hooks.allowConversationAccess`; on older versions those fields are **omitted**.

Useful env overrides: `OPENCLAW_CONFIG_FILE`, `WAMF_MEMORY_ENDPOINT`, `WAMF_MEMORY_API_KEY`, `WAMF_MEMORY_INSTANCE_ID`, `WAMF_MEMORY_TEAM_ID`, `WAMF_MEMORY_AGENT_ID`, `WAMF_MEMORY_USER_ID`, `WRITE_OPENCLAW_CONFIG=0`.

OpenClaw does **not** invoke this script by itself. You can skip it and install manually (below).

### 1. Install OpenClaw CLI

```bash
curl -fsSL https://get.openclaw.dev | bash
openclaw --version
```

### 2. Install plugin dependencies and build

```bash
cd MemoryCore/openclaw-plugin
npm install
npm run build
```

`package.json` depends on npm package [`@weaversoft/memory-fabric-sdk-ts-v2@1.0.0-beta.2`](https://www.npmjs.com/package/@weaversoft/memory-fabric-sdk-ts-v2/v/1.0.0-beta.2) (root entry = v3).

### 3. Link into OpenClaw

```bash
openclaw plugins install -l .
```

### 4. Configure the plugin

The installer writes config by default. Edit manually only when using `WRITE_OPENCLAW_CONFIG=0` or a fully manual install.

> **Important — `hooks.*` is version-gated.**  
> `hooks.allowPromptInjection` / `hooks.allowConversationAccess` are accepted from **OpenClaw `2026.4.24`**. Earlier versions use a strict schema and will **refuse to start** if these fields are present. Check with `openclaw --version`.

**Example A — OpenClaw `>= 2026.4.24` (recommended):**

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-weaverai-client"
    },
    "entries": {
      "memory-weaverai-client": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "server": {
            "url": "http://127.0.0.1:8420",
            "apiKey": "local",
            "instanceId": "default",
            "teamId": "default",
            "agentId": "default",
            "userId": "default"
          },
          "recall": {
            "maxResults": 5,
            "includePersona": true,
            "includeSceneNav": true
          },
          "capture": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

**Example B — OpenClaw `< 2026.4.24`:** omit the `hooks` block entirely; keep the same `config` (including isolation).

`server.instanceId` is sent as `x-wamf-service-id`. Isolation is passed to the v3 SDK at construct time. On remote (`server` install mode), do not use placeholder `local` / `default` unless you set the installer escape hatches.

- `hooks.allowPromptInjection` — allows `before_prompt_build` to inject recalled context.  
- `hooks.allowConversationAccess` — required `true` for non-bundled plugins on 2026.4.24+, otherwise L0 capture is silently blocked.

### 5. Restart OpenClaw Gateway

```bash
openclaw gateway restart
```

## Adapter Responsibilities

| Area | Implementation | Description |
|------|----------------|-------------|
| Capture | `src/hooks/capture.ts` | Writes completed turns to L0 via v3 `addConversation()` |
| Recall | `src/hooks/recall.ts` | Searches before prompt build and injects concise context |
| L1 tool | `src/tools/memory-search.ts` | Agent search of structured memories |
| L0 tool | `src/tools/conversation-search.ts` | Agent search of raw conversation history |
| File read | `src/tools/` (`wamf_read_file`) | Agent read of pipeline artifacts (scenes, core) through the Gateway |

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `server.url` | `http://127.0.0.1:8420` | Memory Gateway URL |
| `server.apiKey` | `local` | Bearer token; use `local` for default standalone |
| `server.instanceId` | `default` | Sent as `x-wamf-service-id` |
| `server.teamId` | `default` | v3 isolation `team_id` |
| `server.agentId` | `default` | v3 isolation `agent_id` |
| `server.userId` | `default` | v3 isolation `user_id` |
| `server.rejectUnauthorized` | `true` | TLS certificate verification |
| `recall.maxResults` | `5` | Max L1 memories injected per turn |
| `recall.includePersona` | `true` | Include L3 core/profile |
| `recall.includeSceneNav` | `true` | Include L2 scene navigation |
| `capture.enabled` | `true` | Auto-capture completed turns |
| `hooks.allowPromptInjection` | `true` | Only write on OpenClaw `>= 2026.4.24` |
| `hooks.allowConversationAccess` | `true` | Only write on OpenClaw `>= 2026.4.24`; required for L0 on non-bundled plugins |

## Files

```text
openclaw-plugin/
├── openclaw.plugin.json       # plugin manifest (id = memory-weaverai-client)
├── package.json               # npm: @weaversoft/memory-fabric-sdk-ts-v2
├── index.ts                   # OpenClaw entrypoint (v3 client + tool registration)
├── src/hooks/capture.ts       # L0 capture
├── src/hooks/recall.ts        # recall + prompt injection
├── src/tools/                 # Agent-callable tools (search + file read)
├── src/format.ts              # prompt formatting
└── docs/architecture.md       # deeper architecture notes
```

## Using This as an Adapter Template

When adapting another Agent framework, reuse the same pattern:

1. After a user/assistant turn, call v3 `addConversation()` (with isolation).
2. Before the next prompt, call `searchAtomic()`, `readCore()`, and optionally `listScenarios()`.
3. Inject only concise, labeled memory context.
4. Expose tools for L1 search, L0 conversation search, and file read (`readScenario()` / `readCore()`).
5. Keep the adapter stateless; the Memory Gateway owns storage and async L1/L2/L3 processing.

## Notes

- Client adapter only: do not start a Memory Gateway subprocess or implement extraction locally.
- If a file read fails, `wamf_read_file` returns a readable error; capture/recall must not depend on it.
- For Gateway startup and broader SDK examples, see the repository root README.
