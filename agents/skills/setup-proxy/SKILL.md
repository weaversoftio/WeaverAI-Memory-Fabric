---
name: setup-proxy
description: Interactively guides the user through connecting an AI Agent to Memory Proxy (probing and verifying step by step)
triggers:
  - configure proxy
  - configure agent
  - setup proxy
  - connect proxy
  - connect memory
---

# Setup Proxy: Agent connection wizard

You are helping the user connect an AI Agent client (Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / Hermes / OpenClaw) to Memory Proxy.

## Background

Memory Proxy is an LLM request proxy that injects team memory/skills/knowledge before forwarding requests to the upstream LLM. Each agent client has its own config file format and protocol:

| Agent | Config file | Protocol | Special requirements |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | 5 model variables in the env field |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | append an entry to the models array |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML; `wire_api = "responses"` is required |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | top-level array |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (no /v1) | two files + chmod 700/600 |
| hermes | `~/.hermes/config.yaml` | OpenAI Chat | needs header preselection (x-team-id/agent-id/task-id) |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | needs header preselection + allowPrivateNetwork |

## Script location

Config-writing script: `agents/skills/setup-proxy/setup-proxy.sh` (relative to the repository root)

## Flow

**Follow this order strictly; each step must pass before moving to the next.**

### Step 1: scan existing configuration

First check whether the user already has a proxy configuration, so they don't re-enter it:

```bash
# Check Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# Check CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# Check the other agents similarly...
```

If you find a URL with a proxy path (containing `/claude-code/`, `/codebuddy/`, `/codex/`, etc.), **extract and show**:
- the proxy address (the part of the URL before `/<agent>/`)
- the instance ID (the segment after `/<agent>/`)
- the user key (the value of the matching field, masked to its first and last 4 characters)
- the model ID

Ask the user: "Found an existing configuration. Reuse it?"
- yes → go to step 3
- no → continue with step 2 and enter values manually

### Step 2: collect the basics

Ask the user for, one at a time:
1. **Proxy address** (with scheme and port, e.g. `http://127.0.0.1:8096`)
2. **Instance ID** (default `default`; usually unchanged in a local deployment)
3. **User key** (from the panel's API Key page; any format)

Confirm each value after getting it; don't ask for all three at once.

### Step 3: pick the Agent

Show the 7 agents and let the user pick **one**:
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. Hermes
7. OpenClaw

### Step 4: model ID

Tell the user:
- the model ID must be one the proxy's upstream supports
- common examples: `claude-sonnet-4-20250514`, `claude-opus-4.7`, `gpt-5.5`, `deepseek-r1`

### Step 5: health probe (key verification step)

**Based on the chosen agent's protocol**, build the matching curl probe:

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / Hermes / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat, but without /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (the more general one)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**Interpreting the result**:
- HTTP connection failure (000) → tell the user the proxy is unreachable and have them check the address/port/service; **don't continue**
- 2xx → all good, continue
- 4xx → the proxy is reachable (possibly the session-init form or an auth problem); **show the response body to the user**, continue
- 5xx → the proxy has a problem; **show the full error response** and ask whether to continue

### Step 6: header preselection (Hermes / OpenClaw only)

If the user chose hermes or openclaw, collect the header preselection values too. These agents don't support the interactive form, so the team/agent/task IDs must be filled into the config in advance.

**Preferred: fetch the lists from the panel API and let the user choose**

Ask whether the user can give the panel backend address (default `http://127.0.0.1:8125`). If so:

```bash
# 1. Get the user_id via auth/verify
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-wamf-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# take it from .data.user.user_id

# 2. Team list
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-wamf-user-key: ${USER_KEY}" \
  -H "x-wamf-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# show .data.items for the user to choose

# 3. Agent list (filtered by owner_user_id)
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-wamf-user-key: ${USER_KEY}" \
  -H "x-wamf-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# show .data.items for the user to choose

# 4. Task list
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-wamf-user-key: ${USER_KEY}" \
  -H "x-wamf-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# the first option is always "Skip for now (no-task)"
```

If the panel is unreachable or the user doesn't want to give it, have the user enter team_id / agent_id / task_id manually.

An **x-conversation-id** is needed as well (you can generate one such as `conv-20260820-xxxx`).

### Step 7: confirm the config file path

Tell the user the default path (see the table above) and ask whether to use it. If not, have the user enter one.

### Step 8: run the script to write the config

Once everything is collected and verified, **call the script in non-interactive mode** to write the config:

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

For Hermes/OpenClaw, append:
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**Check the script's exit code**: 0 = success, non-zero = failure (show the output to the user).

### Step 9: verify what was written

Read the config file back and check it:
```bash
cat <config_path>
```

Show the key fields to the user to confirm.

### Step 9.5: remind the user to switch models

**Writing the config doesn't make it active.** Remind the user to switch to the proxy model in the client, otherwise requests won't go through the proxy:

| Agent | How to switch |
|-------|----------|
| Claude Code | nothing to do; the env in `settings.json` is loaded at startup |
| CodeBuddy | switch the model in the chat box to **proxy-memory-agent** (the configured model ID) |
| Codex | nothing to do; `config.toml` already sets the model |
| WorkBuddy | switch to the matching model in the custom models list of the model picker |
| dsh | nothing to do; `settings.yaml` already sets the model |
| Hermes / OpenClaw | make sure the provider/model chosen in the client points at the proxy configuration |

**Always tell the user**: if they don't switch models, requests won't go through the proxy and memory/skill injection won't happen.

### Step 10: asset import (optional)

After configuring, ask the user whether to import this Agent's local assets (skills + conversation history) into team memory.

If they want to:
- you need the Panel URL, team ID and Agent ID
- if team/agent were already chosen in step 6, suggest reusing them
- otherwise have the user provide them

Then run:
```bash
PANEL_URL="${PANEL_URL}" WAMF_SERVICE_ID="${INSTANCE_ID}" WAMF_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

If `tsx` isn't available, tell the user to run the command manually.

## Error handling

1. **Connection failure**: tell the user exactly which step failed and suggest what to check (service status, port, network)
2. **4xx responses**: the proxy is reachable but there is a business error; show the full response body and help the user work out whether it's a wrong key, an unsupported model or something else
3. **File permissions**: check the directory exists and is writable before writing; dsh needs chmod
4. **Don't guess**: if information is missing or the state is unclear, ask the user rather than assume

## Notes

- configure one agent at a time; afterwards tell the user they can run it again for another agent
- the script backs up the original config file as `.bak.<timestamp>`
- all of CC's model env vars (HAIKU/SONNET/OPUS/SUBAGENT) are set to the model the user chose
- Codex must be switched to Plan mode (Shift+Tab) before the first conversation; this is a client limitation
- dsh's URL has no `/v1`; the client hard-codes it
- Hermes/OpenClaw's x-conversation-id has to be changed by hand for each new conversation
