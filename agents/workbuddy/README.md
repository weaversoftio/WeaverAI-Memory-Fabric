# WorkBuddy (WB)

> agentSource: `workbuddy` | protocol: OpenAI Responses API (Desktop) + Chat Completions (Web) | handler: `workbuddyHandler.ts` (separate)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

WB configures custom models through the **config file** `~/.workbuddy/models.json`:

```json
[
  {
    "id": "claude-opus-4.7-1m",
    "name": "claude-opus-4.7-1m",
    "vendor": "Custom",
    "url": "http://127.0.0.1:8096/workbuddy/default",
    "apiKey": "<the business user's sk-mem-... user_key>",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

Fields:
- `id`: a model ID the proxy's upstream supports (e.g. `claude-opus-4.7-1m`)
- `name`: the name shown in WorkBuddy's "Custom models" list
- `vendor`: for display only (`Custom`, `claude`, etc.); doesn't affect requests
- `url`: proxy address + `/workbuddy/<spaceId>`; `default` is the memory instance ID
- `apiKey`: the business user's `user_key` (from the panel)

Then pick the model under "Custom models" in WorkBuddy's model picker.  
Session init works like CC/CB (pick Team → Agent → Task); the client manages the session ID.

Request paths:
- Desktop: `POST /workbuddy/:spaceId/v1/responses` or `/workbuddy/:spaceId/responses`
- Web: `POST /workbuddy/:spaceId/v1/chat/completions`

Auxiliary paths (as for Codex):
- `/workbuddy/:spaceId/responses/compact`
- `/workbuddy/:spaceId/memories/trace_summarize`
- `/workbuddy/:spaceId/realtime/calls`

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The WB client generates and sends the session ID; nothing for the user to configure.

---

## 3. Session init

WB's session init works like CC/CB: an interactive form to pick Team → Agent → Task.

### 3.1 Interactive form

When the client's `body.tools` includes the `AskUserQuestion` tool, the interactive form is used:

- Tool name: `AskUserQuestion` (same as CC)
- Call ID prefix: `call_wb_session_init_`
- Pagination: CC-style (max 4 options, "More →" to page)
- State machine: reuses the CB state machine

### 3.4 Default-mode gate

WB Desktop has a default-mode gate too (as Codex does):  
the client returns `"request_user_input is unavailable in Default mode"` → the form is skipped for good.

---

## 4. Request classification

WB detects auxiliary requests with the same **three signals** as Codex:

| Signal | What is checked |
|------|----------|
| path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| header | `x-openai-memgen-request: true` |
| body | `body.client_metadata.thread_source` ≠ `"main"` |

---

## 5. User text extraction

Because WB has two protocols, user text extraction has **two modes**:

| Mode | Protocol | Extraction |
|------|------|----------|
| Desktop | Responses API | from `body.input[]` (same algorithm as Codex) |
| Web | Chat Completions | from the `messages[].content` string + stripping `<user_query>` (same algorithm as CB) |

---

## 6. Injection profile

WB has its own injection profile in `injection/agents/workbuddy/`:

- its own parser / serializer
- the system prompt uses a **nunjucks template** with placeholders:
  ```
  {{ WorkbuddyMemory_1 }}
  {{ WorkbuddySkills }}
  {{ WorkbuddyKnowledge }}
  ```
- the injection point depends on the protocol:
  - Responses API: `body.instructions`
  - Chat Completions: `messages[0].content`

---

## 7. Special behaviour

- **Separate handler**: `workbuddyHandler.ts`, with no cross-references to Codex/CB/CC
- **Two protocols side by side**: Desktop uses the Responses API, Web uses Chat Completions, both handled in the same handler
- **Desktop SDK**: the client uses the `@openai/agents 0.5.2` SDK
- **Own header set**: `X-Agent-Intent`, `X-Agent-Purpose`, `X-User-Id`, `X-Codebuddy-Run-Timeout`
- **nginx routing**: an internal nginx needs `/workbuddy/:iid/*` forwarded to the proxy (added 2026-08-13)

---

## 8. Archiving triggers

- shares the archiving mechanism with Codex
- a conversation over the threshold triggers `skill/conversation/add` automatically
- `skill/conversation/force-archive` is supported

---

## 9. Environment variables

No WB-specific variables. The upstream route is decided dynamically by `resolveForwardTarget`.

---

## 10. FAQ

**Q: What is the simplest way to connect WB?**  
A: Send the three headers `x-wamf-team-id` / `x-wamf-agent-id` / `x-wamf-task-id` with the client's requests. The proxy registers the session and injects assets directly, with no interaction delay.

**Q: What happens when WB sends neither the headers nor the tool?**  
A: Silent pass-through. No error, no blocking, but also no memory/skill injection. This is on purpose: WB is not forced to use memory.

**Q: Why do WB Desktop and Web use different protocols?**  
A: The Desktop version uses the `@openai/agents` SDK, which speaks the Responses API; the Web version uses standard Chat Completions. The proxy supports both and tells them apart by path.

**Q: How is WB's code related to Codex's?**  
A: Fully separate. Although both support the Responses API, WB has its own handler, injection profile and template system, with no cross imports.
