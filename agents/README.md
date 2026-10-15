# Agents

Memory Proxy currently supports 7 kinds of AI Agent clients. Their protocols, session-init methods and injection logic differ a lot.

> 🛠 **Want to connect a new AI Agent client (not in the table below)?**
> Read the [**new client adapter guide →**](./adapter-agent-development.md)
> It has a 20-item checklist from "capture and inspect traffic" through "proxy routes / adapter / session-init" to "end-to-end e2e passing", a quick reference of 8 common pitfalls, and the dsh reference implementation to copy from.

## Quick start

### Option 1: run the script yourself

```bash
cd <repository root>
bash agents/setup-proxy.sh
```

An interactive wizard that walks you through connecting an Agent to the Proxy:
1. scans existing configuration (reuses it if present, so you don't re-enter it)
2. pick the Agent to configure
3. enter the model ID
4. health probe (checks the Proxy is reachable)
5. writes the config file (backs up the original as `.bak`)
6. optional: imports local skills/conversations into team memory

All 7 Agents are supported, one per run; run it again to configure another Agent.

### Option 2: let an AI Agent configure it (Skill)

Have Claude Code / CodeBuddy or another AI Agent follow the skill to configure things for you: it probes the environment step by step, checks connectivity and chooses options as it goes.

#### Step 1: copy the agents directory to your home

```bash
cd <repository root>
cp -r agents ~/agents
```

#### Step 2: use one of these prompts in the AI Agent conversation

> Note: the agent must `cd ~/agents` before running the script.

**Connect a new Agent to the Proxy:**

```
Read the skill document ~/agents/skills/setup-proxy/SKILL.md, then follow its steps to guide me through connecting an Agent to Memory Proxy.
```

**Configure a specific Agent (e.g. Claude Code):**

```
Read ~/agents/skills/setup-proxy/SKILL.md and help me connect Claude Code to Memory Proxy. My proxy address is http://localhost:8096 and the instance ID is default.
```

**Configure Hermes/OpenClaw (needs header preselection):**

```
Read ~/agents/skills/setup-proxy/SKILL.md and help me connect Hermes to Memory Proxy. The panel address is http://localhost:8125; fetch the team/agent list from the panel so I can choose.
```

**Health probe only (no config written):**

```
Read ~/agents/skills/setup-proxy/SKILL.md and check whether the proxy at http://localhost:8096 works, using the codebuddy protocol and the model claude-opus-4.7.
```

> ℹ️ The skill file is `agents/skills/setup-proxy/SKILL.md`, with the script `agents/skills/setup-proxy/setup-proxy.sh`. The Agent collects the information and checks the environment step by step, then calls the script in `--non-interactive` mode to write the config.

---

Each subdirectory is one agent and contains:
- `README.md`: connection config, adaptation approach, session-init flow, FAQ
- `asset-import.md`: importing that client's local skills / memory / sessions into the WeaverAI Memory Fabric panel (a one-file manual)
- `asset-import.ts`: that client's disk scanner; the shared entry point is `agents/asset-import.ts` at the repository root, with `--source <name>` picking the IDE
- later: adaptation notes, debug scripts, captured traffic fixtures, etc.

---

## Comparison

| Agent | Protocol | Session init | Form tool | Pagination | Default/Plan gate | Headless bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | interactive form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | interactive form | `ask_followup_question` | ❌ (no limit) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | interactive form + default gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | interactive form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (silent pass-through) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | interactive form + headless bypass | `ask_user_question` | ❌ (no limit) | ❌ | ✅ (when there is no tool) |
| [Hermes](./hermes/) | OpenAI Chat Completions | header preselection (no form) | N/A | N/A | N/A | ✅ (when headers are missing) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | header preselection (no form) | N/A | N/A | N/A | ✅ (when headers are missing) |

---

## Local asset import

Imports the skills / memory / past sessions each client keeps on disk into the WeaverAI Memory Fabric panel. Each client has one scanner file you can run directly:

```bash
# interactive import (asks y/N for skills / memory / sessions one by one)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# non-interactive full import (scripts/CI)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | Manual |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| Hermes | [asset-import.md](./hermes/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID headers

| Agent | Main header | Fallbacks |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| Hermes | `x-conversation-id` | — (static user config) |
| OpenClaw | `x-conversation-id` | — (static user config) |

---

## Client configuration

| Agent | How | Config file / variables | Key |
|-------|----------|-----------------|----------|
| Claude Code | env vars or config file | `~/.claude/settings.json` or env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | config file | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | config file | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | config file | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | config file | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML env var reference |
| Hermes | config file | `~/.hermes/config.yaml` | YAML `api_key` + headers |
| OpenClaw | config file | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## Routes

```
/:agent/:spaceId/v1/messages          → Anthropic protocol (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, Hermes, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat without the v1 prefix (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API without the v1 prefix (Codex, WB-desktop)
```

---

## Header preselection (works for every agent)

Besides the interactive form, **every agent** can register its session directly through HTTP headers and skip the form. Useful when:
- the client can't answer a form (e.g. Hermes / OpenClaw)
- you want to skip the form for a faster first response (e.g. CI/CD automation)
- third-party platforms / your own Agents

### Required headers

| Header | Description |
|--------|------|
| `Authorization: Bearer <user_key>` | the business user's API key (from the panel) |
| `x-team-id` | team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | task ID (required in the current version) |
| `x-conversation-id` | session identifier, generated and managed by the client |

With all of these present → the Proxy registers the session and injects assets directly, with no form.  
Any of them missing → interactive form (if the client supports it) or session bypass (if it doesn't).

### Other platforms

Any OpenAI-API-compatible platform can connect by pointing its API base URL at the Proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: must be one of the values the Proxy supports: `claude-code`, `codebuddy`, `workbuddy`, `codex`, `hermes`, `openclaw`. Other platforms can connect by posing as one of them (e.g. `codebuddy`)
- `<spaceId>`: the memory instance ID (always `default` in a local deployment)

---

## Connecting a new Agent: overview

1. **Capture**: capture 3–5 typical requests (main / aux / title-gen) with mitmproxy and save them in `MemoryProxy/docs/<agent>-recon/`
2. **Identify the protocol**: determine the wire protocol (Anthropic / Chat / Responses)
3. **Find the session ID source**: find the unique session identifier in a header or the body
4. **Choose a session-init strategy**: has a tool → interactive form; no tool → header preselection / headless bypass
5. **Classify auxiliary requests**: recognise title-gen / compact / fork and other requests that don't need the full chain
6. **Implement or reuse a handler**: clients with the same protocol can share a handler (e.g. dsh reuses CB's handleChatCompletions)
7. **Injection profile**: define the injection template for the client's system prompt format
8. **E2E check**: run the full chain and confirm session-init + injection + archiving work

👉 **The full adapter steps (20-item checklist + 8 pitfalls + dsh reference implementation) are in [`adapter-agent-development.md`](./adapter-agent-development.md)**.
