# v3 API reference · Volume 2: MemoryKnowledge

> Service: MemoryKnowledge (Knowledge Service, KS), port `8421`
> This volume covers every `/v3/*` endpoint MemoryKnowledge exposes. MemoryCore is in volume 1, MemoryProxy in volume 3.
> Maintenance rule: an endpoint change must update this document in the same PR.

---

## 1. Common conventions

### 1.1 Service and port

| Item | Value |
|---|---|
| Service | MemoryKnowledge (Knowledge Service, KS) |
| Port | 8421 (`PORT`, default `8421`) |
| API prefix | `/v3` (`API_PREFIX`, default `/v3`) |
| Methods | **everything is `POST`** except `GET /v3/auto-sync/status` and `GET /health` |
| Content-Type | `application/json` |
| Health check | `GET /health` (**not v3**; returns bare JSON `{ status, timestamp }`) |
| Swagger | `GET /docs` (UI), `GET /openapi.json` (spec, not v3) |

### 1.2 Response envelope

**Note: unlike MemoryCore, the KS envelope has no `request_id` field.**

```json
{ "code": 0, "message": "ok", "data": { } }
```

| Field | Type | Description |
|---|---|---|
| code | number | `0` success; non-zero failure, and **the HTTP status = code** (`wrapError(code, ...)` then `c.json(..., code)`) |
| message | string | always `"ok"` on success; on failure a **lowercase English sentence** (not an enum, see §1.5) |
| data | any | business data; `null` on failure |

> `request_id` is optional in the `wrapOk` implementation, but **no route passes it**, so responses are always the three fields `{ code, message, data }`.

> ⚠️ **isError special case (code-graph query tools / tools/call)**: when a tool fails (`result.isError === true`), the HTTP status is **500**, but the body is still the **success envelope** from `wrapOk(result)`: `{ code: 0, message: "ok", data: { text, isError: true } }`. So **`code=0` but HTTP=500**, breaking the usual "HTTP status = code" rule in the table above. The only reliable signal for a failed tool on the frontend is **`data.isError === true`** (the error text is in `data.text`); don't rely on the HTTP status or `code` alone.

### 1.3 Auth

KS uses an **internal-network trust model**, different from MemoryCore's user-key system:

| Item | Description |
|---|---|
| Only required header | `x-wamf-service-id` (tenant/service identifier, i.e. the kernel routing key) |
| Other auth | optional Bearer: when `KNOWLEDGE_SERVICE_KEY` is set, every endpoint outside the read-only allow-list needs `Authorization: Bearer <key>` (including all of `internal/llm-binding/*`); when empty it's off (backward compatible, internal-network trust) |
| Exception | `POST /v3/internal/llm-binding/list` doesn't need the `x-wamf-service-id` header (it returns every binding, for the Panel's startup cache; with the key enabled it still needs the Bearer token) |

> `service_id` / `team_id` / resource IDs all go through **path-segment allow-list validation** (`^[A-Za-z0-9_-]+$`, length ≤200) to prevent path traversal.

### 1.4 IDs and multi-tenancy

| Item | Value |
|---|---|
| Wiki ID | `wiki-` + 8 characters `[0-9a-z]` (e.g. `wiki-a1b2c3d4`) |
| Code-Graph ID | `cg-` + 8 characters `[0-9a-z]` (e.g. `cg-e5f6g7h8`) |
| Multi-tenancy | every endpoint is scoped by `service_id`; **id-only endpoints use `getById(service_id, id)`, and resources of another tenant always return 404 (existence isn't revealed)** |

### 1.5 Error message format

The failure `message` is a **lowercase English sentence** (not an enum, not the `CODE: detail` format). The frontend should branch on the HTTP `code` and not parse the message. Common examples:

| code | message example | Case |
|---|---|---|
| 400 | `x-wamf-service-id header is required` / `wiki_id is required` / `query is required` | missing parameter |
| 400 | `invalid path: traversal detected` / `forbidden path (structural file or outside wiki/)` | invalid path |
| 404 | `wiki not found` / `code graph not found` | resource doesn't exist (including other tenants') |
| 409 | `wiki is processing; cannot write/delete` | state conflict |
| 409 | `busy` | concurrency rejection (ingest/sync) |
| 413 | `content exceeds size limit` / `too many files (max 10)` | over the limit |
| 503 | `code graph instance not loaded` | dependency not ready |

### 1.6 Resource states

| Resource | States | Notes |
|---|---|---|
| Wiki | `draft` → `pending` → `processing` → `ready` / `failed` | `draft` is the initial state of the shell created by create |
| Code-Graph | `pending` / `processing` / `ready` / `failed` | no `draft` |

> Common rule: before `ready`, query endpoints (graph/search/query tools) return **empty results, not errors** (see §3.1/§3.2).

---

## 2. Endpoint list

| Module | Endpoints | Prefix |
|---|---|---|
| Wiki | 16 | `/v3/wiki/*` |
| Code-Graph | 14 | `/v3/code-graph/*` |
| Tools (Agent self-discovery) | 2 | `/v3/tools/*` |
| Internal LLM-Binding | 3 | `/v3/internal/llm-binding/*` |
| Auto-Sync | 2 | `/v3/auto-sync/*` |

**37 endpoints in total.**

---

## 3. Endpoint details

## 3.1 Wiki (16)

> The comment says "15 endpoints"; the code actually has 16 (one more: `update-meta`).
> Two kinds: **id-only** (only `x-wamf-service-id` + `wiki_id`; another tenant's resource gives 404) and **with-team** (needs `team_id`).

**WikiDetail, the common response shape**:

| Field | Type | Description |
|---|---|---|
| wiki_id | string | resource ID |
| team_id | string | team ID |
| name | string | name |
| service_url | string\|null | tools self-discovery base URL |
| summary | string\|null | summary |
| status | string | state (see §1.6) |
| internal_status | string\|null | finer-grained internal state |
| sync_error | string\|null | sync error |
| version | string | version (a string) |
| owner_user_id | string\|null | owner |
| page_count | number\|null | number of pages |
| last_sync_at | string\|null | last sync time |
| created_at / updated_at | string | times |

### POST /v3/wiki/create

Creates a Wiki shell (`draft` state). **Idempotent**: the same name in the same team returns the existing record (HTTP 200); a new one returns 201.

**Request body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | yes | team ID |
| name | string | yes | name |
| user_id / agent_id / task_id | string | no | ownership (owner_user_id = user_id) |

**Response** `data`: `WikiDetail`.

**Errors**: `400` (missing team_id or name).

**Example**

```json
// request
POST /v3/wiki/create
{ "team_id": "t_1", "name": "Team wiki" }

// response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "wiki_id": "wiki-a1b2c3d4",
    "team_id": "t_1",
    "name": "Team wiki",
    "status": "draft",
    "version": "0",
    "owner_user_id": "u_1",
    "created_at": "2026-08-20T00:00:00Z",
    "updated_at": "2026-08-20T00:00:00Z"
  }
}
```

### POST /v3/wiki/list

Paged list by team.

**Request body**: `team_id` (required), `status?`, `limit?` (default 20), `offset?` (default 0).

**Response** `data`: `{ items: WikiDetail[], total }`.

### POST /v3/wiki/get

id-only single lookup.

**Request body**: `wiki_id` (required).

**Response** `data`: `WikiDetail`.

**Errors**: `404` (wiki not found).

### POST /v3/wiki/update-meta

Updates name / summary.

**Request body**: `wiki_id` (required), `name?`, `summary?` (at least one).

**Response** `data`: `WikiDetail`.

**Errors**: `400` (neither given), `404`.

### POST /v3/wiki/delete

Batch delete (cascades to connections/metadata/disk + unregisters the engine).

**Request body**: `wiki_ids` (1–100, non-empty array).

**Response** `data`: `BatchDeleteResult` = `{ deleted_ids: string[], failed: [{ id, reason }] }`.

> A single failure doesn't fail the whole call; it goes into `failed` (reason: `invalid id` / `not found` / `delete failed`).

### POST /v3/wiki/ingest

Triggers Wiki extraction. **An empty wiki (no source files) is rejected**.

**Request body**: `wiki_id` (required), `user_id?`.

**Response** `data`: `{ wiki_id, status }` (HTTP `202`).

**Errors**: `400` (empty wiki), `404` (doesn't exist), `409` (busy; data carries `{ status, step }`).

### POST /v3/wiki/raw/ls

Lists the raw source files (id-only).

**Request body**: `wiki_id`.

**Response** `data`: `{ items: RawFile[] }`.

### POST /v3/wiki/raw/read

Batch-reads raw files (id-only).

**Request body**: `wiki_id`, `filenames: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400` (parameters), `404` (wiki doesn't exist / file missing), `413` (too large).

### POST /v3/wiki/raw/write

Uploads source files (with-team). **Raw files must be written before triggering ingest**.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | yes | team ID |
| wiki_id | string | yes | Wiki ID |
| files | object[] | yes | `[{ filename, content }]`, ≤10 files, ≤512KB each, ≤5MB in total |
| user_id / agent_id / task_id | string | no | ownership |

**Response** `data`: `{ items }`.

**Errors**: `400` (invalid structure), `404`, `409` (processing), `413` (over the limit).

**Example**

```json
// request
POST /v3/wiki/raw/write
{ "team_id": "t_1", "wiki_id": "wiki-a1b2c3d4", "files": [ { "filename": "README.md", "content": "# Home" } ] }

// response
{ "code": 0, "message": "ok", "data": { "items": [ { "filename": "README.md", "status": "written" } ] } }
```

### POST /v3/wiki/raw/rm

Deletes raw files (with-team).

**Request body**: `team_id`, `wiki_id`, `filenames: string[]`.

**Response** `data`: deletion result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/ls

Lists the extracted pages (id-only).

**Request body**: `wiki_id`.

**Response** `data`: `{ items: Page[] }` (`Page = { ref, title, path }`).

### POST /v3/wiki/page/read

Batch-reads pages (id-only).

**Request body**: `wiki_id`, `refs: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`.

### POST /v3/wiki/page/write

Writes pages (with-team).

**Request body**: `team_id`, `wiki_id`, `pages: [{ ref, content }]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/rm

Deletes pages (with-team).

**Request body**: `team_id`, `wiki_id`, `refs: string[]`.

**Response** `data`: deletion result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/graph

Knowledge graph (id-only). **Not `ready` returns an empty graph (not an error)**.

**Request body**: `wiki_id`.

**Response** `data`: `{ nodes: [], edges: [], communities: [] }` (empty before ready; once ready, the result of `wikiMgr.graph`).

### POST /v3/wiki/search

Full-text search (BM25, id-only). **Not `ready` returns empty results (not an error)**.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| wiki_id | string | yes | Wiki ID |
| query | string | yes | search terms |
| limit | number | no | default 20 |
| hop | number | no | graph expansion hops, integer 0–5 |
| decay | number | no | decay factor 0–1 |
| minScore | number | no | minimum relevance (non-negative) |

**Response** `data`: `{ results, links, count }`.

**Errors**: `400` (query missing / hop/decay/minScore out of range), `404`.

**Example**

```json
// request
POST /v3/wiki/search
{ "wiki_id": "wiki-a1b2c3d4", "query": "release", "limit": 10 }

// response
{ "code": 0, "message": "ok", "data": { "results": [ { "ref": "page/release-plan", "title": "Release plan" } ], "links": [], "count": 1 } }
```

---

## 3.2 Code-Graph (14)

> The comment says "13 endpoints"; there are actually 14 (one more: `update-meta`).
> Two kinds: **Management** (6: create/list/get/update-meta/sync/delete) and **Query** (8: search/explore/callers/callees/impact/node/status/files).
> Queries delegate to `engines/code executeTool` and return a `{ text, isError }` text block.

**CodeGraphDetail, the common response shape**:

| Field | Type | Description |
|---|---|---|
| code_graph_id | string | resource ID |
| team_id | string | team ID |
| repo_name | string | repository name |
| repo_url | string | repository address |
| branch | string | branch (default main) |
| commit_hash | string\|null | commit |
| service_url | string\|null | tools self-discovery base URL |
| summary | string\|null | summary |
| status | string | state (see §1.6) |
| sync_error | string\|null | sync error |
| version | string | version |
| owner_user_id | string\|null | owner |
| stats | `{ files, nodes, edges }`\|null | statistics |
| last_sync_at | string\|null | last sync time |
| created_at / updated_at | string | times |

### POST /v3/code-graph/create

Creates a Code-Graph (`pending`, build triggered automatically). **Idempotent**: the same repo_url+branch returns the existing record (200); a new one returns 201.

**Request body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | yes | team ID |
| repo_url | string | yes | repository address. Private repositories need the server-wide git credentials (`KNOWLEDGE_GIT_AUTH_*`); a URL that embeds a password or token fails the build (status `failed`, reason in `sync_error`) |
| branch | string | no | branch, default `main` |
| repo_name | string | no | repository name |
| user_id / agent_id / task_id | string | no | ownership |

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400` (missing team_id/repo_url).

**Example**

```json
// request
POST /v3/code-graph/create
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "code_graph_id": "cg-e5f6g7h8",
    "team_id": "t_1",
    "repo_name": "repo",
    "repo_url": "https://github.com/org/repo",
    "branch": "main",
    "status": "pending",
    "version": "0",
    "owner_user_id": "u_1"
  }
}
```

### POST /v3/code-graph/list

Paged list by team.

**Request body**: `team_id` (required), `status?`, `limit?`, `offset?`.

**Response** `data`: `{ items: CodeGraphDetail[], total }`.

### POST /v3/code-graph/get

id-only single lookup.

**Request body**: `code_graph_id`.

**Response** `data`: `CodeGraphDetail`.

**Errors**: `404`.

### POST /v3/code-graph/update-meta

Updates repo_name / summary.

**Request body**: `code_graph_id`, `repo_name?`, `summary?` (at least one).

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400`, `404`.

### POST /v3/code-graph/sync

Triggers a sync (rebuilds the index).

**Request body**: `code_graph_id`, `user_id?`.

**Response** `data`: `{ code_graph_id, status }` (HTTP `202`).

**Errors**: `404`, `409` (busy; data carries `{ status, step }`).

### POST /v3/code-graph/delete

Batch delete.

**Request body**: `code_graph_ids` (1–100, non-empty).

**Response** `data`: `BatchDeleteResult`.

---

### Query tools (8, all id-only)

> The 8 query endpoints are registered in one loop over `CODEGRAPH_QUERY_TOOL_NAMES` and share one handler:
> - first `getById(service_id, code_graph_id)` checks ownership, with `404` as the fallback;
> - **not `ready` returns `{ text: "", isError: false }` (HTTP 200, not an error)**;
> - parameters are strictly validated against the `QUERY_SPECS` allow-list; **any undeclared field gives 400** (`unexpected field: xxx`);
> - it delegates to `executeTool`; when the result has `isError=true` the HTTP status is 500 but the body is still the `code=0` success envelope, and the failure signal is `data.isError=true` (see the isError special case in §1.2).

| Endpoint | Parameters (default/range) | Description |
|---|---|---|
| `POST /search` | `query` (required), `kind?` (function/method/class/interface/type/variable/route/component), `limit?` (default 10, 1–100) | search by symbol name; returns locations only (no source) |
| `POST /explore` | `query` (required), `maxFiles?` (default 12, 1–200) | **preferred**: returns the full source of relevant symbols grouped by file |
| `POST /callers` | `symbol` (required), `limit?` (default 20, 1–200) | lists the functions that call symbol |
| `POST /callees` | `symbol` (required), `limit?` (default 20, 1–200) | lists the functions symbol calls |
| `POST /impact` | `symbol` (required), `depth?` (default 2, 1–10) | impact analysis |
| `POST /node` | `symbol` (required), `includeCode?` (default false), `file?`, `line?` (≥1) | full information on one symbol (optionally with source) |
| `POST /status` | no parameters | index health check |
| `POST /files` | `path?`, `pattern?`, `format?` (tree/flat/grouped, default tree), `includeMetadata?` (default true), `maxDepth?` (≥1) | indexed file tree |

**Common request body**: `code_graph_id` (required) + the parameters above.

**Common response** `data`: `{ text: string, isError: boolean }`.

**Common errors**: `400` (parameters), `404` (code graph not found), `500` (tool failed, `data.isError=true`, body still code=0), `503` (instance not loaded).

**Example** (explore)

```json
// request
POST /v3/code-graph/explore
{ "code_graph_id": "cg-e5f6g7h8", "query": "user login logic", "maxFiles": 12 }

// response
{
  "code": 0,
  "message": "ok",
  "data": { "text": "```src/auth.ts\n...\n```", "isError": false }
}
```

---

## 3.3 Tools: Agent self-discovery (2)

> v7 progressive exposure: an LLM Agent first discovers the available tools with `tools/list`, then runs them with `tools/call`.
> Only **read-only query tools** are exposed; management operations (create/delete/ingest/sync) are not.
> `knowledge_id` decides the resource type: `wiki-*` → the Wiki tool set (7), `cg-*` → the Code-Graph tool set (9).

### POST /v3/tools/list

Lists the tools available for a knowledge resource.

**Request body**: `knowledge_id` (required).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| knowledge_id | string | echoed |
| type | string | `wiki` / `code-graph` |
| name | string | resource name |
| summary | string\|null | summary |
| status | string | resource state |
| tools | object[] | `[{ name, description, params }]` |

**Errors**: `400` (knowledge_id missing/invalid format), `404` (resource doesn't exist).

**Example**

```json
// request
POST /v3/tools/list
{ "knowledge_id": "wiki-a1b2c3d4" }

// response
{
  "code": 0,
  "message": "ok",
  "data": {
    "knowledge_id": "wiki-a1b2c3d4",
    "type": "wiki",
    "name": "Team wiki",
    "status": "ready",
    "tools": [
      { "name": "search", "description": "BM25 full-text search over wiki page content. Find relevant documents by keyword.", "params": { "query": { "type": "string", "required": true } } }
    ]
  }
}
```

### POST /v3/tools/call

Runs a tool.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| knowledge_id | string | yes | resource ID |
| tool_name | string | yes | tool name |
| params | object | yes | tool parameters (as defined by tools/list) |

**Response** `data`: the tool result (wiki tools return structured data; code-graph tools return `{ text, isError }`).

**Errors**: `400` (parameters), `403` (unknown tool), `404` (resource doesn't exist), `500` (code-graph tool failed, `data.isError=true`, body still code=0), `503` (instance not loaded).

> **Tool allow-list** (tool_name):
> - Wiki (7): `get_info`, `search`, `list_pages`, `read_page`, `get_graph`, `list_raw`, `read_raw`
> - Code-Graph (9): `get_info`, `search`, `explore`, `callers`, `callees`, `impact`, `node`, `status`, `files`

---

## 3.4 Internal LLM-Binding (3)

> Per-instance LLM routing config, for the control plane (TMC / operator curl). `api_key` is never echoed.

### POST /v3/internal/llm-binding/set

Upserts a binding (`proxy`\|`byo`). **Idempotent**: a repeated set overwrites.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| mode | string | yes | `proxy` / `byo` |
| proxy_base_url | string | required for proxy | proxy LLM address |
| base_url | string | required for byo | your own LLM address |
| api_key | string | required the first time | for an existing record, omitting it keeps the old value |
| enabled | boolean | no | default true |

**Response** `data`: `{ service_id, mode, enabled, updated_at }` (**no api_key**).

**Errors**: `400` (invalid mode / missing address / api_key missing the first time).

### POST /v3/internal/llm-binding/status

Reads the binding state (without api_key).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| bound | boolean | whether a binding is configured |
| mode | string\|null | `proxy` / `byo`; `null` when not configured |
| enabled | boolean | whether it's enabled; `false` when not configured |

> When not configured it returns `{ bound: false, mode: null, enabled: false }`.

### POST /v3/internal/llm-binding/list

Lists every binding (**doesn't need the `x-wamf-service-id` header**).

**Response** `data`: `{ items: [{ service_id, mode, proxy_base_url, base_url, has_api_key, enabled }] }`.

---

## 3.5 Auto-Sync (2)

> State query + manual trigger for the scheduled sync scheduler. **No auth**. One of the rare v3 modules with a GET.

### GET /v3/auto-sync/status

Reads the scheduler's run state + config.

**Response** `data`: `{ running, activeSyncs, scanning, ... , config: { enabled, scanIntervalMs, maxConcurrentSyncs } }`.

### POST /v3/auto-sync/trigger

Manually triggers one full scan (fire-and-forget, returns immediately).

**Response** `data`: `{ triggered: boolean, reason? }` (`triggered=false` + reason when `KNOWLEDGE_AUTO_SYNC_ENABLED` is off).

---

## 4. Appendix

### 4.1 Key differences from MemoryCore (read before integrating across volumes)

| Dimension | MemoryCore (volume 1) | MemoryKnowledge (this volume) |
|---|---|---|
| envelope | `{ code, message, request_id, data }` | `{ code, message, data }` (**no request_id**) |
| auth | layered Bearer + service-id + user-key | `x-wamf-service-id` only (internal-network trust) |
| error message | three formats (enum / 5-digit code / `CODE: detail`) | lowercase English sentence (branch on the HTTP code) |
| paged response | `{ items, total, limit, offset }` | `{ items, total }` (limit/offset not echoed) |
| ID prefix | skill `skl-`, etc. | wiki `wiki-`, code-graph `cg-` |

### 4.2 Endpoint count corrections

| File | Comment says | Actual | Difference |
|---|---|---|---|
| `wiki.ts` | 15 endpoints | 16 | extra `update-meta` |
| `code-graph.ts` | 13 endpoints | 14 | extra `update-meta` |

### 4.3 Idempotency summary

| Endpoint | Idempotent behaviour |
|---|---|
| `wiki/create` | the same name in the same team returns the existing record (200, not an error) |
| `code-graph/create` | the same repo_url+branch returns the existing record (200) |
| `llm-binding/set` | a repeated set overwrites (omitting api_key keeps the old value) |
| `wiki/delete`, `code-graph/delete` | a single failure doesn't fail the whole call; it goes into the `failed` array |
