# CodeBuddy (CB)

> agentSource: `codebuddy` | protocol: OpenAI Chat Completions / Anthropic Messages | handler: `handler.ts` (shared)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

CB configures custom models through the **config file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<the business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

Fields:
- `id`: a model ID the proxy's upstream supports (e.g. `claude-sonnet-4-20250514`)
- `name`: the name shown in the CodeBuddy chat box; anything you like
- `vendor`: for display only (e.g. `claude`, `openai`); doesn't affect requests
- `apiKey`: the business user's `user_key` (from the panel; same as CC's `ANTHROPIC_AUTH_TOKEN`)
- `url`: proxy address + `/codebuddy/<spaceId>`; `default` is the memory instance ID

Then pick that model in the CB chat box.

### ⚠️ Version limitation

> CodeBuddy **4.10.2 – 4.10.4** doesn't send a sessionId, so session init can't complete.  
> **Use ≥ 4.10.5 or ≤ 4.10.1**.

Request paths:
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CB IDE plugin generates and sends `x-conversation-id` automatically.

---

## 3. Session init (form)

### 3.1 Mechanism

CB uses the **`ask_followup_question`** function_call for the interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE tool_calls chunks or Anthropic SSE

### 3.2 State machine

```
asset_confirm → team_select → agent_task_select → initialized
```

4 steps:
1. **asset_confirm**: whether to inject assets ("Yes, link team assets" / "No, not this time")
2. **team_select**: pick the team
3. **agent_task_select**: pick the Agent + task together
4. **initialized**: assets are injected and the normal conversation starts

### 3.3 Pagination

CB's `ask_followup_question` has **no limit** on the number of options, so no pagination.  
All options are shown at once.

### 3.4 Plan mode / default mode

CB has **no** default-mode gate. The CB client always has the `ask_followup_question` tool, so the form can always be sent.

### 3.5 Skipping session init

- choose "No, not this time" at the `asset_confirm` step → all later steps are skipped and requests pass straight through
- answer "skip" at any step → matched by SKIP_RE and skipped

---

## 4. Request classification

CB's request classification is simple:

| Type | Description |
|------|------|
| **main** | every request is main by default |

CB has **no** fork / sidequery / compact or other auxiliary requests. Every request goes through the full chain.

---

## 5. User text extraction

CB's `message.content` is always a **plain string** (not an array of content blocks).

Extraction:
1. look for a `<user_query>...</user_query>` XML wrapper in the string
2. if found → take the inner text
3. if not → use the whole string as the user text
4. strip CB's pseudo-XML tags (`<agent_context>`, `<code_context>`, etc.)

---

## 6. Injection profile

System prompt injection with an **XML structure**:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point:
- OpenAI: `messages[0].content` (appended inside the system message string)
- Anthropic: the `system` field

---

## 7. Special behaviour

- **Own header set**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant placeholder**: a CB assistant message may be the `"-"` placeholder (empty reply marker)
- **Shared handler**: dsh reuses this handler too (`handleChatCompletions`)
- **Two protocols**: the same CB version may use the OpenAI or the Anthropic protocol; the handler adapts automatically

---

## 8. Archiving triggers

- a conversation over the threshold triggers `skill/conversation/add` automatically
- `skill/conversation/force-archive` is supported
- archived data is written to L0

---

## 9. Environment variables

No CB-specific variables. Use the global proxy config:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

The actual upstream is decided dynamically by `resolveForwardTarget` (tokenhub / direct provider).

---

## 10. FAQ

**Q: What are the main differences between CB and CC?**  
A: Different protocol (OpenAI vs Anthropic), different content structure (string vs content-block array), no auxiliary request classification, no pagination of options.

**Q: Who adds CB's `<user_query>` wrapper?**  
A: The CB IDE plugin wraps the user's original text before sending; the proxy strips it when extracting.

**Q: How does CB on the Anthropic protocol differ from CC?**  
A: The form tool name differs (`ask_followup_question` vs `AskUserQuestion`), content is still a string, injection uses XML instead of Markdown, and the agentSource tag is different.
