# v3 API reference · Volume 3: MemoryProxy

> Service: MemoryProxy (LLM reverse proxy + injection proxy), port `8096`
> This volume covers every `/v3/*` endpoint MemoryProxy exposes (**6 in total**, all ops/management). MemoryCore is in volume 1, MemoryKnowledge in volume 2.
> Maintenance rule: an endpoint change must update this document in the same PR.

---

## 1. Common conventions

### 1.1 Service and port

| Item | Value |
|---|---|
| Service | MemoryProxy |
| Port | 8096 |
| Prefix in this volume | `/v3` (ops management only; **the main LLM paths, `/v1/messages`, `/:agent/:spaceId/v1/*`, etc., are outside the v3 docs**) |
| Health check | `GET /health` (not v3; returns bare JSON with status/version/upstream/storage, etc.) |
| `GET /whoami` | not v3; API key → key ID (plain text) |

### 1.2 Envelope (**not uniform; two kinds**)

MemoryProxy's v3 endpoints use two envelopes, **both different from volume 1 MemoryCore and volume 2 MemoryKnowledge**:

| Endpoint group | Envelope | Notes |
|---|---|---|
| `instance/proxy-destroy`, `admin/rate-limits` (3 methods) | `{ code, message, data }` | **no `request_id`** (same style as volume 2 KS) |
| `session/refresh-cache`, `session/force-archive-skill` | `{ code, message, request_id, data }` | has `request_id`, with the value `refresh-${Date.now()}` / `force-archive-${Date.now()}` |

Success is always `code=0, message="ok"`.

### 1.3 Auth (**only 1 endpoint is authenticated**)

| Endpoint | Auth |
|---|---|
| `POST /v3/instance/proxy-destroy` | `Authorization: Bearer <admin.apiKey>`; **public when `admin.apiKey` isn't configured** (`checkAdminAuth` lets an empty key straight through). Compared in constant time with `timingSafeEqual` |
| `admin/rate-limits` (GET/PUT/DELETE) | **no auth** |
| `session/refresh-cache`, `session/force-archive-skill` | **no auth** |

> ⚠️ The implementation and the comments disagree: the header comments of `session-refresh.ts` / `session-force-archive.ts` say "goes through admin auth (reusing the admin-auth.ts pattern)", but **the handlers never call `checkAdminAuth`**, so they are currently unauthenticated. This document records what the code actually does; if the frontend/operations rely on auth, harden it separately.

### 1.4 Error codes (**two groups**)

| Endpoint group | Failure code | HTTP status |
|---|---|---|
| `proxy-destroy`, `rate-limits` | standard 3-digit (400/401/503) | = code |
| `session/*` | **5-digit numbers** (40001/40401/50001) | 3-digit (400/404/500), **code ≠ HTTP** |

> On failure, `session/*` returns a 5-digit `code` and a plain-text `message`, but a standard 3-digit HTTP status (`status = error.includes("not found") ? 404 : 400/500`). Note that the frontend must treat code and HTTP status separately here.

### 1.5 Identity and auth headers

The ops endpoints in this volume **don't check** `x-wamf-service-id` / `x-wamf-user-key` (unlike the volume 1 data plane); only `proxy-destroy` honours a Bearer token.

---

## 2. Endpoint list

| Method | Path | Description |
|---|---|---|
| POST | `/v3/instance/proxy-destroy` | ops: clear the proxy-side instance cache (the only authenticated one) |
| GET | `/v3/admin/rate-limits` | read the rate-limit config (global / per-dimension override) |
| PUT | `/v3/admin/rate-limits` | set the rate-limit config (global / per-dimension override) |
| DELETE | `/v3/admin/rate-limits` | delete the rate-limit config (restore defaults / remove an override) |
| POST | `/v3/session/refresh-cache` | refresh a session's injection cache (refetch agent/task detail + prewarm) |
| POST | `/v3/session/force-archive-skill` | manually force-archive a session's skill buffer |

**6 endpoints in total (4 routes, of which rate-limits has 3 HTTP methods).**

---

## 3. Endpoint details

## 3.1 Instance destroy

### POST /v3/instance/proxy-destroy

Clears the proxy-side cached data of an instance (spaceId). The contract's field names match Core's `/v3/instance/destroy`; the path uses the `proxy-destroy` action to tell them apart.

**Auth**: `Authorization: Bearer <admin.apiKey>` (public if not configured).

**Request body**: `{ instance_id: string }` (non-empty + no `/` + no `..`, validated with `assertKeySegment`).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| instance_id | string | echoed |
| cleaned.storage_backend | string | `sqlite` / `fs` / `memory` |
| cleaned.storage_ttl_deleted | number | entries deleted under the `ttl/<id>/` prefix; 0 if none |
| cleaned.storage_nottl_deleted | number | entries deleted under the `nottl/<id>/` prefix |
| cleaned.redis_skipped | string | always `per-session-ttl-only` |

**Partial failure**: a failed step doesn't stop the rest; `cleaned` then contains the matching `storage_ttl_error` / `storage_nottl_error` field (HTTP is still 200).

**Errors**: `400` (invalid JSON / missing instance_id / invalid characters), `401` (auth enabled and the Bearer token missing or wrong).

> The Redis session store (`cg:sess:*`) is **not cleared**: the sessionKey comes from `x-conversation-id` / `x-claude-code-session-id` and contains no spaceId, so it can't be SCANned by space; it expires naturally with the default 1800s TTL.

**Example**

```json
// request
POST /v3/instance/proxy-destroy
Authorization: Bearer <admin.apiKey>
{ "instance_id": "mem-example001" }

// response
{
  "code": 0,
  "message": "ok",
  "data": {
    "instance_id": "mem-example001",
    "cleaned": {
      "storage_backend": "sqlite",
      "storage_ttl_deleted": 3,
      "storage_nottl_deleted": 5,
      "redis_skipped": "per-session-ttl-only"
    }
  }
}
```

---

## 3.2 Rate-limit config (3 methods, all unauthenticated)

> Rate limiting has two levels: **global** (`config.rateLimit`) and **per-dimension overrides** (`instance_id + model_id`). A per-dimension override wins over the global value.

### GET /v3/admin/rate-limits

Reads the rate-limit config.

**Query**: `instance_id` + `model_id` (**must be given together**).

**Response** `data`:

- without parameters (global): `{ enabled, tpm, qpm, window_seconds: 60, overrides: [...] }`
- with instance_id+model_id (dimension): `{ enabled, instance_id, model_id, input_tpm, qpm, source: "global"|"override", global }`

**Errors**: `400` (only one of instance_id / model_id given), `503` (store error).

### PUT /v3/admin/rate-limits

Sets the rate-limit config.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| input_tpm | number | yes | input tokens per minute, **positive integer** |
| qpm | number | yes | requests per minute, **positive integer** |
| instance_id | string | no | together with model_id |
| model_id | string | no | together with instance_id (≤256, no control characters) |

**Response** `data`: without a dimension returns `{ tpm, qpm }`; with a dimension returns `{ instance_id, model_id, input_tpm, qpm }`.

**Errors**: `400` (invalid JSON / not a positive integer / only one dimension field / invalid model_id), `503`.

**Example**

```json
// request (set the global value)
PUT /v3/admin/rate-limits
{ "input_tpm": 100000, "qpm": 300 }

// response
{ "code": 0, "message": "ok", "data": { "tpm": 100000, "qpm": 300 } }
```

### DELETE /v3/admin/rate-limits

Deletes the rate-limit config (restores the defaults).

**Request body**: optional `instance_id` + `model_id` (together).

**Response** `data`: without a dimension returns `{ tpm, qpm }` (back to the config defaults); with a dimension returns `{ instance_id, model_id, deleted: true }`.

**Errors**: `400`, `503`.

---

## 3.3 Session management (2, both unauthenticated)

> Both endpoints are the underlying implementation of `mem:` commands (as function calls) and are also exposed over HTTP for the panel frontend to reuse.

### POST /v3/session/refresh-cache

Refreshes all injection caches of the current session: refetches the Agent/Task detail and writes it into the SessionStore → reruns `prewarmFromConfig` with `clearBefore=true` (clearing old snapshots of assets that were unbound).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | yes | — | session key |
| agent_source | string | no | `claude-code` | proxy source, combined as `compositeKey = ${agentSource}:${sessionKey}` |
| user_key | string | no | — | caller key passed to the MetadataClient |
| space_id | string | no | — | fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| refreshed | string[] | hookIds refreshed successfully |
| skipped | string[] | hookIds skipped |
| agent_refreshed | boolean | whether the agent detail was refetched |
| task_refreshed | boolean | whether the task detail was refetched |
| took_ms | number | duration |

**Errors**: `40001` (invalid JSON / missing session_key / `Session not initialized` / other parameter errors), `40401` (session not found). The failure message is plain text (`session_key is required`, `Session not initialized: xxx`, `Session not found: xxx`).

**Example**

```json
// request
POST /v3/session/refresh-cache
{ "session_key": "sess_1", "agent_source": "claude-code", "space_id": "mem-example001" }

// response
{
  "code": 0,
  "message": "ok",
  "request_id": "refresh-1724112000000",
  "data": {
    "refreshed": ["memory", "knowledge"],
    "skipped": ["skill"],
    "agent_refreshed": true,
    "task_refreshed": false,
    "took_ms": 120
  }
}
```

### POST /v3/session/force-archive-skill

Manually force-archives the current session's skill buffer (the third trigger, which skips the threshold check).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | yes | — | session key |
| agent_source | string | no | `claude-code` | proxy source |
| reason | string | no | — | archive reason (passed through to Core) |
| space_id | string | no | — | fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| status | string | `archived` / `empty` |
| task_id | string? | archive task ID (archived only) |
| archive_key | string? | archive key |
| archived_at_ms | number? | archive time (ms) |

**Errors**: `40001` (invalid JSON / missing session_key), `40401` (session not found), `50001` (calling Core's `forceArchive` failed).

**Example**

```json
// request
POST /v3/session/force-archive-skill
{ "session_key": "sess_1", "reason": "manual" }

// response
{
  "code": 0,
  "message": "ok",
  "request_id": "force-archive-1724112000000",
  "data": { "status": "archived", "task_id": "skl_1", "archive_key": "archive/xxx", "archived_at_ms": 1724112000000 }
}
```

---

## 4. Appendix

### 4.1 Differences across the three volumes

| Dimension | MemoryCore (volume 1) | MemoryKnowledge (volume 2) | MemoryProxy (this volume) |
|---|---|---|---|
| port | 8420 | 8421 | 8096 |
| envelope | `{ code, message, request_id, data }` | `{ code, message, data }` | **both kinds** (see §1.2) |
| auth | layered Bearer + service-id + user-key | `x-wamf-service-id` only | only proxy-destroy honours Bearer; the rest are unauthenticated |
| methods | all POST | all POST except auto-sync status | **includes GET/PUT/DELETE** (rate-limits) |
| failure codes | three kinds (enum / 5-digit / CODE:detail) | standard 3-digit | proxy-destroy/rate-limits 3-digit; session/* 5-digit |

### 4.2 Known implementation deviations (recorded as the code behaves)

| File | Comment claims | Actual implementation |
|---|---|---|
| `session-refresh.ts` | "goes through admin auth" | never calls `checkAdminAuth`; no auth |
| `session-force-archive.ts` | same (not stated outright, but the same family) | no auth |
| `admin/rate-limits` | — | no auth (harden it if it needs protecting) |

### 4.3 Boundary with the main LLM path

This volume only covers the `/v3/*` ops endpoints. The core of MemoryProxy is the **LLM reverse proxy** (`/v1/messages`, `/v1/chat/completions`, `/:agent/:spaceId/v1/*`, `/codex·workbuddy·dsh/:spaceId/*`, etc.) and the **bridges** (`/skill-bridge/*`, `/memory-bridge/*`). These are **outside the v3 API docs**; document them in a separate volume if needed.
