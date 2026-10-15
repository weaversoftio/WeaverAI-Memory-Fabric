#!/usr/bin/env bash
# Forwards this Claude Code hook's JSON input (stdin) to the memory server and prints its JSON answer.
# Settings come from the plugin's options, which Claude Code exports as CLAUDE_PLUGIN_OPTION_*.
# A failure here never blocks Claude Code: on any error the script prints nothing and exits 0.
#
# Saving is per project and off until the user agrees (the server asks through the agent).
# The project is the repo's git remote, sent as X-Memory-Project with any credentials removed.
# "#nomemory" in a prompt stops saving that chat; it's handled here, so nothing more from
# the chat is even sent.

url="${CLAUDE_PLUGIN_OPTION_MEMORY_URL:-https://weaverai-api.platform.weaversoft.io/api/mcp-proxy/memory-mcp}"
input="$(cat)"

field() { printf '%s' "$input" | grep -o "\"$1\" *: *\"[^\"]*\"" | head -1 | sed -E 's/.*: *"([^"]*)"$/\1/'; }
event="$(field hook_event_name)"
session="$(field session_id | tr -cd 'A-Za-z0-9_-')"

# #nomemory: a local flag per chat, so a paused chat stays paused even if the server restarts.
flags="${HOME}/.claude/agent-memory/paused"
if [ -n "$session" ] && [ "$event" != "SessionStart" ]; then
  if [ -f "$flags/$session" ]; then exit 0; fi
  if [ "$event" = "UserPromptSubmit" ] && printf '%s' "$input" | grep -qi '#nomemory'; then
    mkdir -p "$flags" && : > "$flags/$session"
    find "$flags" -type f -mtime +7 -delete 2>/dev/null
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Agent Memory: this chat is no longer saved (the user wrote #nomemory). Do not save anything from it with the memory tools either."}}'
    exit 0
  fi
fi

args=(-s -m "${AGENT_MEMORY_HOOK_TIMEOUT:-15}" -X POST
  -H "Content-Type: application/json")
# Production identifies you by your WAIP token; only a local server needs the memory key.
if [ -n "${CLAUDE_PLUGIN_OPTION_MEMORY_KEY:-}" ]; then
  args+=(-H "X-Memory-User-Key: ${CLAUDE_PLUGIN_OPTION_MEMORY_KEY}")
fi
if [ -n "${CLAUDE_PLUGIN_OPTION_AGENT_ID:-}" ]; then
  args+=(-H "X-Memory-Agent-Id: ${CLAUDE_PLUGIN_OPTION_AGENT_ID}")
fi
if [ -n "${CLAUDE_PLUGIN_OPTION_PLATFORM_TOKEN:-}" ]; then
  args+=(-H "Authorization: Bearer ${CLAUDE_PLUGIN_OPTION_PLATFORM_TOKEN}")
fi
remote="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" remote get-url origin 2>/dev/null | sed -E 's#(://)[^/@]+@#\1#')"
if [ -n "$remote" ]; then
  args+=(-H "X-Memory-Project: ${remote}")
fi

printf '%s' "$input" | curl "${args[@]}" --data-binary @- "${url%/}/hooks/claude-code" || true
exit 0
