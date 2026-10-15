# Codex

> agentSource: `codex` | protocol: OpenAI Responses API | handler: `codexHandler.ts` (separate)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

Codex is configured through the **config file** `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "WAMF team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<the business user's sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

Fields:
- `wire_api = "responses"`: **required**; Codex uses the OpenAI Responses API protocol
- `base_url`: proxy address + `/codex/<spaceId>`; `default` is the memory instance ID
- `experimental_bearer_token`: the business user's `user_key` (from the panel)
- `disable_response_storage = true`: turns off local caching so every turn goes through proxy injection
- `stream_idle_timeout_ms = 120000`: avoids timeouts while session-init waits for the user

> ⚠️ **Switch to Plan mode (`Shift+Tab`) before the first conversation.** Codex's default Agent mode runs tool calls automatically and skips the user's choice, so session-init never finishes. Switch back to Agent mode after choosing Team→Agent→Task.

Request paths:
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses` (without the v1 prefix, also accepted)

Auxiliary paths:
- `/codex/:spaceId/responses/compact`: compact requests
- `/codex/:spaceId/memories/trace_summarize`: trace summaries
- `/codex/:spaceId/realtime/calls`: realtime calls

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The Codex CLI generates the session_id and writes it to both the header and the body; nothing for the user to configure.

---

## 3. Session init (form)

### 3.1 Mechanism

Codex uses the **`request_user_input`** function_call for the interactive form:

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_` (⚠️ the `fc_` prefix is mandatory; the OpenAI Responses spec validates it strictly)
- Call ID prefix: `call_codex_session_init_`
- Protocol: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 State machine

Reuses the CB state machine, tagged with `agentSource="codex"`, `protocol="responses"`:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Codex uses its own `computeCodexPagination`, with rules similar to CC (limited number of options) but a separate implementation. The paging option is labelled "More...".

### 3.4 ⚠️ Default-mode gate (key difference)

Codex has two run modes:
- **Suggest mode**: the `request_user_input` tool is available → the form works normally
- **Default mode**: the client blocks `request_user_input` calls

**Detecting default mode**: after the proxy sends the form, the client's `function_call_output.output` contains:

```
"request_user_input is unavailable in Default mode"
```

When the proxy sees this gate string → session-init is **skipped for good** and every later request passes straight through.

### 3.5 Skipping session init

Three ways:
1. the default-mode gate triggers automatically → skipped for good
2. the user types "skip"
3. choose "No, not this time" at asset_confirm

---

## 4. Request classification

Codex detects auxiliary requests with **three signals**:

| Signal | What is checked |
|------|----------|
| path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| header | `x-openai-memgen-request: true` |
| body | `body.client_metadata.thread_source` ≠ `"main"` |

Any one of them → auxiliary → no injection/archiving.

---

## 5. User text extraction

Taken from the `body.input[]` array:
1. find the last item with `type: "message"` and `role: "user"`
2. take the text of every `input_text` block in its `content[]`
3. join them into the final user text

⚠️ Codex's body structure is completely different from Chat Completions (`input[]` rather than `messages[]`).

---

## 6. Injection profile

Uses the codex-specific injection builder `buildCodexInjectionBlock`:

```
injected into the instructions field (not messages/input)
```

Codex's injection point is `body.instructions` (the Responses API equivalent of the system prompt).

---

## 7. Special behaviour

- **Separate handler**: `codexHandler.ts`, not shared with CB/CC
- **Mandatory fc_ prefix**: the OpenAI Responses API requires function_call ids to start with `fc_`, otherwise the client's replay gets a 400
- **Marker routes**: `/codex/:spaceId/cost-guard/responses` and `/codex/:spaceId/analyse/responses` split traffic for cost-guard/analyse
- **Archiving hook**: on 2026-08-11 codex got its `skill/conversation/add` + WAMF L0 write (before that, data was silently dropped)

---

## 8. Archiving triggers

- a conversation over the threshold triggers `skill/conversation/add` automatically (through the responses branch of `normalize-conversation`)
- `skill/conversation/force-archive` is supported
- Codex archives are converted to the common format by `normalizeCodexConversation`

---

## 9. Environment variables

```env
PROXY_PORT=8096
# Codex upstream (your org's Codex-compatible gateway, e.g. https://api.weaverai.example.com)
# routed dynamically by resolveForwardTarget
```

The Codex upstream base URL is typically the service root (without `/v1` or `/v2`), e.g. `https://api.weaverai.example.com`.  
Available models: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`; `claude-*` is rejected outright.

---

## 10. FAQ

**Q: Is there no memory injection at all in Codex default mode?**  
A: Correct. Once the default-mode gate triggers the proxy passes everything through without injection. That follows from the codex client's design: default mode aims for minimal latency.

**Q: What is the fc_ prefix issue?**  
A: The OpenAI Responses API validates the function_call id field with a regex: it must start with `fc_`. The proxy uses the `fc_codex_session_init_` prefix when generating the form and keeps the `call_` prefix for call_id. Before this fix, the codex client's 5th replayed request always got a 400.

**Q: What is Codex's /compact request?**  
A: Like CC's conversation compaction: an auxiliary request the client triggers automatically, which needs no injection/archiving.

**Q: How do Codex and CB share code?**  
A: Codex has its own `codexHandler.ts`, but underneath, the session-init state machine reuses CB's implementation (with different agentSource + protocol parameters).

---

## 11. Differences from Claude Code / CodeBuddy

| Dimension | Claude Code | CodeBuddy | Codex |
|------|-------------|-----------|-------|
| protocol | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| config | env vars | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| key | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| session init | form appears automatically | form appears automatically | **switch to Plan mode manually the first time** |
