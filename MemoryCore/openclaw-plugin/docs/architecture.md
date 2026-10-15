# WeaverAI Memory Fabric Client: OpenClaw memory plugin (client edition)

> Created: 2026-05-17 | Status: in development
> Plugin ID: `memory-weaverai-client`
> Display name: WeaverAI Memory Fabric (Client)

## 1. Background

After the move to a service architecture, all four memory layers (L0 conversation / L1 atomic / L2 scene / L3 persona) are hosted on a remote Gateway:
- **Storage**: SQLite or MongoDB (records + search) + local files or MongoDB (`rowfs`/`mongofs`) for documents + Redis (state)
- **Pipeline**: the Gateway workers run the L1→L2→L3 extraction automatically
- **API**: 15 v2 REST endpoints cover all CRUD + search

**The original plugin (memory-weaverai)** is "full stack": local SQLite + local pipeline + local embedding + OpenClaw hooks + CLI, ~15000 lines.

**The new plugin (memory-weaverai-client)** is a pure client: it only registers OpenClaw hooks + tools, and delegates every data operation to the remote Gateway through `@weaversoft/memory-fabric-sdk-ts-v2`.

## 2. Three layers

```
┌───────────────────────────────────────────────────────┐
│  OpenClaw Plugin (memory-weaverai-client)            │  framework adapter layer
│  hooks (recall/capture) + tools + prompt injection    │  depends only on the SDK, no HTTP/storage
│  └─ import { MemoryClient } from SDK                  │
├───────────────────────────────────────────────────────┤
│  @weaversoft/memory-fabric-sdk-ts-v2 (own package)    │  general SDK layer
│  MemoryClient (all memory + file-read APIs)           │  no framework deps, plain fetch
│  later reused by Dify / AutoGen / LangChain           │
├───────────────────────────────────────────────────────┤
│  Gateway API                                          │  remote service
│  SQLite/MongoDB + file store + Redis + Pipeline Worker│
└───────────────────────────────────────────────────────┘
```

## 3. Plugin responsibilities (framework adapter only)

| Feature | Hook/Tool | Implementation |
|------|-----------|------|
| **conversation capture** | `agent_end` hook | SDK `client.addConversation()` |
| **memory recall** | `before_prompt_build` hook | in parallel: `client.searchAtomic()` + `client.readCore()` + `client.listScenarios()` |
| **tag cleanup** | `before_message_write` hook | strips the `<relevant-memories>` tag |
| **L1 search** | `wamf_memory_search` tool | SDK `client.searchAtomic()` |
| **L0 search** | `wamf_conversation_search` tool | SDK `client.searchConversation()` |
| **file reading** | `wamf_read_file` tool | SDK `client.readScenario()` / `client.readCore()` (read through the Gateway) |
| **prompt injection** | inside recall | formats Persona + L1 memories + Scene Navigation + tool guidance |

### What it doesn't do

- ❌ no VectorStore / SQLite / MongoDB
- ❌ no EmbeddingService
- ❌ no Pipeline / Timer / Worker
- ❌ no L1/L2/L3 extraction
- ❌ no file-store backend management
- ❌ no Redis state management
- ❌ no local checkpoint

## 4. Configuration

```jsonc
{
  // Gateway connection
  "gateway.url": "http://127.0.0.1:8420",
  "gateway.apiKey": "",
  "gateway.instanceId": "default",

  // recall
  "recall.maxResults": 5,
  "recall.includePersona": true,
  "recall.includeSceneNav": true,

  // capture
  "capture.enabled": true
}
```

## 5. Layout

```
memory-weaverai-client/
├── openclaw.plugin.json       # plugin manifest
├── package.json               # deps: { "@weaversoft/memory-fabric-sdk-ts-v2": "1.0.0-beta.2" }
├── index.ts                   # entry: initialises the SDK + registers hooks/tools
├── src/
│   ├── hooks/
│   │   ├── recall.ts          # before_prompt_build → SDK recall → prompt injection
│   │   └── capture.ts         # agent_end → SDK addConversation
│   ├── tools/
│   │   ├── memory-search.ts   # wamf_memory_search → SDK searchAtomic
│   │   ├── conversation-search.ts  # → SDK searchConversation
│   │   └── read-file tool     # wamf_read_file → SDK readScenario / readCore
│   └── format.ts              # recall result formatting + tool guidance injection
├── .gitignore
└── README.md
```

## 6. SDK dependency strategy

```jsonc
"dependencies": {
  "@weaversoft/memory-fabric-sdk-ts-v2": "1.0.0-beta.2"
}
```

The SDK is published on the npm registry: [`@weaversoft/memory-fabric-sdk-ts-v2@1.0.0-beta.2`](https://www.npmjs.com/package/@weaversoft/memory-fabric-sdk-ts-v2/v/1.0.0-beta.2). `npm install` fetches it; no more vendoring / local `file:` / tgz.
The SDK stays a separate package, not tied to any framework, so a future Dify plugin, Python version, etc. can reuse it.

## 7. wamf_read_file tool design

### Reads through the Gateway

- scene files and the core memory are read with the SDK's `client.readScenario({ path })` / `client.readCore()`
- the Gateway serves them from whichever file store it is configured with (`local` or `rowfs`), so the plugin needs no storage credentials
- auth reuses the plugin's Gateway API key / instance ID

### How the AI knows it can call wamf_read_file

1. **Scene Navigation at the end of the persona**:
   ```
   ## 🗺️ Scene Navigation
   ### Path: scene_blocks/career-and-engineering-practice.md
   **Heat**: 3 | Summary: backend engineer, Go + TypeScript...
   ```
   When the AI sees a path it calls `wamf_read_file` to read the details.

2. **Tool guidance (injected by format.ts)**:
   ```
   <memory-tools-guide>
   - wamf_memory_search: search structured memories
   - wamf_conversation_search: search raw conversations
   - wamf_read_file: read scene files (use the paths from Scene Navigation)
   </memory-tools-guide>
   ```

3. **Tool description**:
   ```
   "Read a memory file. Use paths from Scene Navigation
    (e.g. 'scene_blocks/xxx.md') or 'persona.md'."
   ```

## 8. Key design decisions

### Q1: How is the session_id determined?

It uses the `ctx.sessionKey` the OpenClaw framework passes in (part of the hook context), the same as the original plugin. Nothing to generate or assemble.

### Q2: Offline/disconnected fallback?

Not in the first version: when the Gateway is unreachable the hook returns nothing (no memory injected) and a failed capture logs a warning. A local fallback can come later.

### Q3: Does it conflict with the original plugin?

The plugin IDs differ (`memory-weaverai-client` vs `memory-weaverai`), so no conflict. But enabling both captures/injects twice, so enable only one.

## 9. Implementation steps

| # | Task | Estimate |
|---|------|------|
| 1 | `package.json` + `openclaw.plugin.json` + `.gitignore` + `README.md` | 15 min |
| 2 | `index.ts`: initialise the SDK Client + register hooks/tools | 30 min |
| 3 | `hooks/capture.ts`: agent_end → addConversation | 20 min |
| 4 | `hooks/recall.ts` + `format.ts`: parallel recall + prompt formatting | 45 min |
| 5 | `tools/*.ts`: forwarding for the 3 tools | 30 min |
| 6 | local integration testing | 30 min |

**Total**: ~3 hours
