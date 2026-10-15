#!/usr/bin/env bash
# Connects Cursor (macOS / Linux) to Agent Memory: the memory MCP tools, plus hooks that save
# every turn and load your agent's memory when a chat starts. Writes ~/.cursor/mcp.json and
# ~/.cursor/hooks.json (user level), backing up existing files and keeping other entries.
#
#   bash install-cursor.sh [--url URL] [--key sk-mem-...] [--agent-id ID] [--platform-token TOKEN] [--uninstall]
#
# Needs python3 (for merging JSON) and curl.
set -euo pipefail

URL="https://weaverai-api.platform.weaversoft.io/api/mcp-proxy/memory-mcp"; KEY=""; AGENT_ID=""; TOKEN=""; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --platform-token) TOKEN="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is needed to update Cursor's JSON files." >&2; exit 1; }
# Production identifies you by your WAIP token; only a local server needs the memory key.
if printf '%s' "$URL" | grep -Eq '://(localhost|127\.0\.0\.1)'; then LOCAL=1; else LOCAL=0; fi
if [ "$UNINSTALL" = 0 ] && [ "$LOCAL" = 1 ] && [ -z "$KEY" ]; then
  read -r -s -p "Your memory key (sk-mem-..., from the WeaverAI Memory Fabric panel's API Key page): " KEY; echo
fi
if [ "$UNINSTALL" = 0 ] && [ "$LOCAL" = 0 ] && [ -z "$TOKEN" ]; then
  read -r -s -p "Your WAIP token (from the memory-mcp entry's Connection tab in the WAIP MCP store): " TOKEN; echo
fi

mkdir -p "$HOME/.cursor"
URL="$URL" KEY="$KEY" AGENT_ID="$AGENT_ID" TOKEN="$TOKEN" UNINSTALL="$UNINSTALL" python3 - <<'PY'
import json, os, shlex, shutil, time
home = os.path.expanduser("~/.cursor")
mcp_path, hooks_path = os.path.join(home, "mcp.json"), os.path.join(home, "hooks.json")
marker, events = "/hooks/cursor", ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse"]

def load(path, empty):
    if not os.path.exists(path) or not open(path).read().strip():
        return empty
    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy(path, backup)
    os.chmod(backup, 0o600)
    return json.load(open(path))

mcp = load(mcp_path, {"mcpServers": {}})
mcp.setdefault("mcpServers", {})
hooks = load(hooks_path, {"version": 1, "hooks": {}})
hooks.setdefault("version", 1)
hooks.setdefault("hooks", {})
for ev in events:
    hooks["hooks"][ev] = [h for h in hooks["hooks"].get(ev, []) if marker not in h.get("command", "")]

if os.environ["UNINSTALL"] == "1":
    mcp["mcpServers"].pop("agent-memory", None)
else:
    key = os.environ["KEY"]
    if key and not key.startswith("sk-mem-"):
        raise SystemExit("That doesn't look like a memory key; it should start with sk-mem-.")
    base = os.environ["URL"].rstrip("/")
    headers = {"X-Memory-User-Key": key} if key else {}
    if os.environ["AGENT_ID"]: headers["X-Memory-Agent-Id"] = os.environ["AGENT_ID"]
    if os.environ["TOKEN"]: headers["Authorization"] = f"Bearer {os.environ['TOKEN']}"
    mcp["mcpServers"]["agent-memory"] = {"url": f"{base}/mcp", "headers": headers}
    header_args = " ".join(f"-H {shlex.quote(f'{k}: {v}')}" for k, v in headers.items())
    command = f"curl -s -m 15 -X POST -H 'Content-Type: application/json' {header_args} --data-binary @- {shlex.quote(base + marker)}"
    for ev in events:
        hooks["hooks"][ev].append({"command": command, "timeout": 20})

json.dump(mcp, open(mcp_path, "w"), indent=2)
json.dump(hooks, open(hooks_path, "w"), indent=2)
# Both files hold your token or memory key: readable by you only.
for p in (mcp_path, hooks_path):
    os.chmod(p, 0o600)
print("Removed Agent Memory from Cursor." if os.environ["UNINSTALL"] == "1" else f"Agent Memory is set up for Cursor ({base}).")
print("Restart Cursor to apply.")
PY
