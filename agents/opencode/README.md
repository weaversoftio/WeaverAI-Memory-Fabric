# OpenCode

> agentSource: `opencode` | protocol: OpenAI Chat Completions | handler: `handler.ts` (shared with CB / dsh)

---

## 1. Client configuration

OpenCode is an open-source AI coding CLI [from SST](https://github.com/sst/opencode). It connects to the proxy through a
custom provider in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<the business user's sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

Fields:
- `baseURL`: proxy address + `/opencode/<spaceId>/v1`; `default` is the memory instance ID (spaceId)
- `apiKey`: the business user's `user_key` (copied from the OpenCode card in the MemoryPanel)
- `models.<id>.name`: a model ID the proxy's upstream supports (e.g. `claude-opus-4.7-1m`)
- OpenCode uses the `@ai-sdk/openai-compatible` provider, which speaks the **OpenAI Chat Completions** protocol

Start OpenCode and pick a model under `proxy-memory` in the `/model` picker.

Request paths:
- main path: `POST /opencode/:spaceId/v1/chat/completions`
- bare variant: `POST /opencode/:spaceId/chat/completions` (when `baseURL` has no `/v1`)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

The OpenCode client itself sends **no** session ID header. The proxy generates a
stable sessionId for each request (based on the request context), which behaves like "each session is separate".

If a wrapper / proxy layer adds `x-conversation-id`, the proxy uses that first.

---

## 3. Session init (form)

### 3.1 Mechanism

OpenCode reuses CB's **`ask_followup_question`** function_call mechanism for the interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_` (the handler uses a separate prefix for opencode, distinct from CB's `call_session_init_` / dsh's `call_dsh_session_init_`)
- Protocol: OpenAI SSE tool_calls chunks

### 3.2 State machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

No limit; all options are shown at once.

### 3.4 Skipping session init

- choose "No, not this time" at `asset_confirm` → straight pass-through
- answer "skip" at any step → skipped

---

## 4. Marker routes (⚠️ important)

OpenCode can add a **marker** URL segment to trigger cost-guard routing or the analyse request classification,
exactly as with CB / Codex:

| Marker | Path | Purpose |
|--------|------|------|
| (none) | `/opencode/<spaceId>/v1/chat/completions` | default, general pipeline |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | forces the cost-guard tier |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | classifies the request as analyse |

Bare variants (when `baseURL` has no `/v1`):
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 Marker gate

Both marker routes are gated by the `assetReflection.markerOptIn` setting:
- `markerOptIn: true` → matched and active
- `markerOptIn: false` → returns `404 {"error":"cost_guard_marker_disabled"}` or similar

See `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`.

### 4.2 Using it from the client

Switch the `baseURL` in opencode.json directly:

```jsonc
// default tier
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// force cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// analyse classification (for back-end pipelines to recognise)
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. Request classification

OpenCode's request classification is simple:

| Type | Description |
|------|------|
| **main** | every request is main by default |
| **analyse** | marked analyse when the URL has the `/analyse/` marker (for the report layer) |

OpenCode has **no** fork / sidequery / compact or other auxiliary requests.

---

## 6. User text extraction

OpenCode's `message.content` is a **plain string** (no content block array and no
XML wrapper):

- no `<user_query>` wrapper (unlike CB)
- no content block array (unlike CC)
- the content string of the last user message is used directly

Image input passes through as `image_url` content parts (the client base64-encodes them and the proxy
forwards them unchanged to the upstream); the proxy does nothing special with them.

---

## 7. Injection profile

OpenCode shares CB's handler path (both are OpenAI Chat Completions), and injection works the same way:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (appended inside the system message string).

---

## 8. Special behaviour

- **Shared handler**: OpenCode reuses CB's `handleChatCompletions` (the same path as dsh)
- **agentSource**: the `/opencode/` route segment → `agentSource=opencode`
- **No header fingerprint of its own**: the OpenCode CLI sends no custom headers; the proxy relies on the URL segment + user-agent
- **Marker routes**: the two URL markers `/cost-guard/` and `/analyse/`, see §4

---

## 9. Archiving triggers

- shares the archiving mechanism with CB / dsh
- a conversation over the threshold triggers `skill/conversation/add` automatically
- `skill/conversation/force-archive` is supported
- archived data is written to L0

---

## 10. Environment variables

No OpenCode-specific variables. The upstream route is decided dynamically by `resolveForwardTarget`
(usually tokenhub or a direct provider).

---

## 11. FAQ

**Q: OpenCode shares a handler with CB / dsh; how are they told apart?**  
A: At the routing level by the `/:agent/` segment. Inside the handler `agentSource=opencode` triggers
OpenCode-specific behaviour (marker routes, self-generated session ID, etc.).

**Q: Does `baseURL` in opencode.json need `/v1`?**  
A: Recommended (the main path), but the proxy also accepts the bare variant without `/v1`. Both work.

**Q: The marker route returns 404?**  
A: Check that `assetReflection.markerOptIn` in `MemoryProxy/z_config/config.yaml` is
`true`. Then reload with `./scripts/proxy.sh restart`.

**Q: Does the OpenCode CLI support the `@image:path` syntax?**  
A: That's a client-side OpenCode feature and has nothing to do with the proxy. The client reads the file, base64-encodes it into an `image_url`
content part, and the proxy passes it through to the upstream unchanged.

**Q: Can local past sessions / skills be imported into the WeaverAI Memory Fabric panel?**  
A: The OpenCode client doesn't keep skill / session files locally (unlike CB / dsh), so there is no
`asset-import.md` yet. To import past conversations, import them manually in the Panel or use the `mem:sync` command.

---

## 12. Differences from CB / dsh

| Dimension | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| protocol | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| config | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL prefix | `/codebuddy/<spaceId>` | `/dsh/<spaceId>` (without `/v1`) | **`/opencode/<spaceId>`** |
| provider library | built in | built in | **`@ai-sdk/openai-compatible`** |
| key | JSON `apiKey` | env var in `.credentials.yaml` | **JSON `provider.*.options.apiKey`** |
| form tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`** (same as CB) |
| session ID | client sends `x-conversation-id` | client sends `x-deepseek-harness-session-id` | **generated by the proxy** |
| marker routes | none | none | **`/cost-guard/` `/analyse/`** |
| local asset import | yes (`asset-import.md`) | yes (`asset-import.md`) | **no** (the client keeps no files) |

---

## 13. Current status

- ✅ code complete (the handler reuses the CB path)
- ✅ marker routes (cost-guard / analyse) unit tests 6/6 passing
- ✅ end-to-end curl verification passed (3 real upstream streaming responses)
- ✅ the Panel shows an OpenCode card
