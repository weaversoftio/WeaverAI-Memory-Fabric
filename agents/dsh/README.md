# DeepSeek Harness (dsh)

> agentSource: `dsh` | protocol: OpenAI Chat Completions | handler: `handler.ts` (shared with CB)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

dsh is configured through the **config files** `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`:

**`~/.dsh/settings.yaml`**:
```yaml
llm-deepseek:
  # dsh reads the proxy user_key from the environment variable with this name
  apiKeyEnv: PROXY_USER_KEY

  # ⚠️ no trailing /v1: dsh hard-codes ${baseURL}/chat/completions
  baseURL: http://127.0.0.1:8096/dsh/default

  # thinking mode
  reasoningEffort: high
```

**`~/.dsh/.credentials.yaml`**:
```yaml
PROXY_USER_KEY: <the business user's sk-mem-... user_key>
```

**Required permissions** (dsh checks them at startup and refuses to start if they're wrong):
```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

Fields:
- `baseURL`: proxy address + `/dsh/<spaceId>`; **without `/v1`** (the dsh client hard-codes `${baseURL}/chat/completions`)
- `apiKeyEnv`: the name of the environment variable to read the key from; the value itself is in `.credentials.yaml`
- `PROXY_USER_KEY`: the business user's `user_key` (from the panel)

Request paths (⚠️ dsh uses no `/v1` prefix):
- `POST /dsh/:spaceId/chat/completions` (main path)
- `POST /dsh/:spaceId/v1/chat/completions` (also accepted)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

The dsh client generates the session ID and sends it in a header; nothing for the user to configure. The proxy only takes it from the header; there is no body fallback.

---

## 3. Session init (form)

### 3.1 Mechanism

dsh uses the **`ask_user_question`** tool_call for the interactive form:

- Tool name: `ask_user_question`
- Call ID prefix: `call_dsh_session_init_`
- Protocol: OpenAI Chat Completions SSE

### 3.2 State machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

dsh's options list has **no limit**, so no pagination. All options are shown at once.

### 3.4 Headless bypass (⚠️ key difference)

dsh has its own **headless bypass**:

- the proxy checks the `body.tools` array
- if `body.tools` is non-empty **but doesn't contain** the `ask_user_question` tool → the proxy treats it as headless
- in headless mode → session-init is **skipped entirely** and requests pass straight through

This lets dsh work where it has no interaction ability (direct API calls, batch mode).

### 3.5 reasoning_content requirement

The dsh client uses DeepSeek's thinking mode and **strictly requires** assistant messages to include a `reasoning_content` field.  
The proxy puts a non-empty `reasoning_content` placeholder into the form responses it generates.

### 3.6 Skipping session init

Three ways:
1. headless bypass (no `ask_user_question` among the tools) → skipped automatically
2. the user types "skip"
3. choose "No, not this time" at asset_confirm

### 3.7 First session: pick Team → Agent → Task

Start the Web UI:

```bash
cd /path/to/deepseek-harness
pnpm dsh web --port 3080
# or: node apps/cli/lib/bin.js web --port 3080
```

Open <http://127.0.0.1:3080> in the browser and send a message (e.g. "hi"). The proxy returns a 4-step button form:

1. "Link team assets?": **Yes, link team assets** injects them, **No, not this time** passes straight through
2. Team picker (skipped automatically when there is only one team)
3. Agent picker
4. Task picker (the first option is the virtual **"Skip for now"**)

After that the Agent introduces itself, and every later turn automatically gets blocks such as `<session_context>` + `<available_skills>` + `<wamf_profile_memory>` injected.

mem commands such as `mem:help` / `mem:sync` / `mem:create-skill` work too once session init is done.

---

## 4. Request classification

dsh has its own classification logic:

| Type | How it's recognised | Handling |
|------|----------|------|
| **compact** | `x-deepseek-harness-compact: 1` header | auxiliary request, no injection |
| **title-gen** | combined body features: no tools + thinking.disabled + max_tokens≤128 + system starts with "Create a concise title..." | auxiliary request, no injection |
| **main** | everything else | full chain |

---

## 5. User text extraction

dsh message content is always a **plain string** with no wrapper tags:
- no `<user_query>` wrapper (unlike CB)
- no content block array (unlike CC)
- the content string of the last user message is used directly

---

## 6. Injection profile

dsh shares CB's handler path (both are OpenAI Chat Completions), and injection works like CB's:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (appended inside the system message string).

---

## 7. Special behaviour

- **Shared handler**: dsh reuses CB's `handleChatCompletions` (not a separate handler)
- **Client fingerprint headers**:
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`
  - `x-deepseek-harness-session-id`
  - `x-deepseek-harness-compact`
- **Thinking mode**: assistant messages may carry a `reasoning_content` field (the DeepSeek thinking chain)
- **No `<user_query>` wrapper**: shares the handler with CB but extracts user text differently (dsh strips no tags)

---

## 8. Archiving triggers

- shares the archiving mechanism with CB
- a conversation over the threshold triggers `skill/conversation/add` automatically
- `skill/conversation/force-archive` is supported

---

## 9. Environment variables

No dsh-specific variables. The upstream route is decided dynamically (usually the DeepSeek API).

---

## 10. FAQ

**Q: dsh and CB share a handler; how are they told apart?**  
A: At the routing level by the `/:agent/` segment. Inside the handler the `agentSource` field drives the differences (form tool name, session ID header, content extraction, etc.).

**Q: When does the dsh headless bypass trigger?**  
A: When the client's `body.tools` is non-empty but doesn't contain `ask_user_question`. Typical case: dsh called directly in API mode (custom tools, but no user-interaction tool).

**Q: What is dsh's `x-deepseek-harness-compact` header?**  
A: The dsh client sends it when compacting the conversation. The proxy recognises it, skips injection/archiving, and passes the request straight to the upstream for compaction.

**Q: Why does dsh need a reasoning_content placeholder?**  
A: The DeepSeek thinking-mode client strictly validates the assistant message format: there must be a `reasoning_content` field. The session-init form response the proxy generates is also an assistant message, so it must include the field (see pitfall D in [the adapter guide](../adapter-agent-development.md) for why it must be non-empty).

---

## 11. Differences from Claude Code / CodeBuddy / Codex

| Dimension | Claude Code | CodeBuddy | Codex | **dsh** |
|---|---|---|---|---|
| protocol | Anthropic Messages | OpenAI Chat | OpenAI Responses | **OpenAI Chat** |
| config | env vars | `~/.codebuddy/models.json` | `~/.codex/config.toml` | `~/.dsh/settings.yaml` + `.credentials.yaml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` | **`/dsh/<spaceId>`** (without `/v1`) |
| key | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` | env var in `.credentials.yaml` |
| session init | form appears automatically | form appears automatically | switch to Plan mode the first time | **form appears automatically** |
| UI form tool | `AskUserQuestion` | `ask_followup_question` | fake `function_call` | **`ask_user_question`** (native to dsh) |
| wire specifics | cache_control markers | none | encrypted rs_id | **`reasoning_content` required on tool-call turns** (handled by the proxy) |

---

## 12. Current status

- ✅ code complete
- ✅ verified locally
- ⚠️ not yet used at scale in production
