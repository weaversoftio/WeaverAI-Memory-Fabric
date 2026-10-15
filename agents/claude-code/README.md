# Claude Code (CC)

> agentSource: `claude-code` | protocol: Anthropic Messages API | handler: `anthropicHandler.ts`
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

### Option 1: environment variables

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<the business user's sk-mem-... user_key>"
claude --model <the upstream model configured in PROXY_UPSTREAM_MODEL>
```

### Option 2: config file `~/.claude/settings.json` (recommended, persistent)

Edit `~/.claude/settings.json` and put this in the `env` field:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<the business user's sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

Then just run `claude`; CC loads the environment variables from the `env` field of `settings.json` at startup.

### Fields

- `ANTHROPIC_BASE_URL`: points CC's API at the proxy instead of anthropic.com; `default` in the path is the memory instance ID (`x-wamf-service-id`), always `default` in a local deployment
- `ANTHROPIC_AUTH_TOKEN`: the **business user's** user_key (from the panel's "API Key" page; using the admin key directly is not recommended)
- `ANTHROPIC_MODEL`: the upstream model name (can also be given with the `--model` command-line flag)

> If the proxy's upstream is an OpenAI-compatible endpoint (for example a LiteLLM gateway), the gateway must translate Anthropic `/v1/messages` requests; LiteLLM does this. See `deploy/global-images/README.md`.

The proxy then does: `auth` (checks the user_key) → `sessionInit` (team/agent/task form) → `injection` (puts L2/L3 memory, skills and knowledge into the system prompt) → forwards to the upstream LLM.

The client's requests hit `POST /claude-code/:spaceId/v1/messages`.

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC generates a session ID for every new session and sends it with each request; nothing to configure.

---

## 3. Session init (form)

### 3.1 Mechanism

CC uses **native Anthropic `tool_use`** for the interactive form:

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- Protocol: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 State machine

```
team_select → agent_select → task_select → initialized
```

4 steps:
1. **team_select**: pick the team
2. **agent_select**: pick the Agent
3. **task_select**: pick the task (includes an isDefault virtual option, "Skip for now")
4. **initialized**: assets are injected and the normal conversation starts

### 3.3 Pagination

CC's `AskUserQuestion` tool has a hard limit of **2–4 options** (an Anthropic protocol constraint).  
With more than 3 options, pagination kicks in:

- each page shows 3 real options + 1 "More →" option
- choosing "More →" returns the next page
- the last page has no "More →" option

### 3.4 Plan mode / default mode

CC has **no** default-mode gate. The CC client always supports tool_use, so the form can always be sent.

### 3.5 Skipping session init

At any step, answering "skip" (or choosing Other and typing skip) skips that step (matched by the `SKIP_RE` regex, `/\bskip\b/i`).  
After a skip the proxy passes requests through without injecting assets.

---

## 4. Request classification

CC distinguishes many request types:

| Type | How it's recognised | Handling |
|------|----------|------|
| **main** | default | full chain (injection + archiving + tracking) |
| **fork** | position of the `cache_control` marker | full chain (subagents share the session_id) |
| **sidequery** | `cache_control` marker + specific pattern | lightweight handling |
| **compact** | path suffix `/compact` | auxiliary request, no injection |
| **title-gen** | path suffix + body features | auxiliary request, no injection |

CC's `cache_control` marker is the key signal for main vs auxiliary requests.

---

## 5. User text extraction

Taken from the last `role: "user"` message in `body.messages`:
- the last `type: "text"` content block
- **skipping** blocks that start with `<system-reminder>` (those are system injections, not user text)

---

## 6. Injection profile

System prompt injection with a **Markdown structure**:

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

The injection point is the `body.system` field (in the Anthropic protocol, system is separate from messages).

---

## 7. Special behaviour

- **resetEpoch**: supports the `mem:session-reset` command, with a cross-node stale check
- **Vertex AI relay**: passes `x-vertex-ai-session-id` through
- **Fork/subagent**: when CC's `task` command starts a subagent the session_id stays the same, and the proxy archives the subagent and the main agent together
- **mem commands**: full support for `mem:sync` / `mem:create-skill` / `mem:session-reset`, etc.

---

## 8. Archiving triggers

- a conversation over the threshold (tokens / turns) triggers `skill/conversation/add` automatically
- `skill/conversation/force-archive` archives manually
- archived data is written to L0 (WAMF write)

---

## 9. Environment variables

No CC-specific variables. The global proxy config is enough:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC's upstream
```

---

## 10. FAQ

**Q: Can CC get stuck because the form has too many options?**  
A: No. Pagination guarantees at most 4 options at a time, though with many options the user has to page several times.

**Q: Do CC subagent requests repeat session-init?**  
A: No. Subagents reuse the main agent's session_id; the proxy sees it is already initialized and skips the form.

**Q: Do CC's auxiliary requests (title-gen / compact) get injection?**  
A: No. Once the proxy recognises an auxiliary request it passes it straight through, with no injection/archiving.
