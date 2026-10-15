# Agent Memory for Claude Code and Cursor

Connects your coding agent to the team's Agent Memory while it keeps its own model and login:

- **Memory tools (MCP):** search, add, edit and delete memory (`memory_search`, `memory_add`, …)
- **Every turn saved:** your message and the agent's reply go to your agent's raw history (L0), and the memory pipeline extracts facts from them in the background
- **Memory at session start:** each new chat starts with your agent's profile and scene list (or its most recent facts)

Everything goes through the `memory-mcp` entry in the WAIP MCP store as **you**, so you only reach memory you're allowed to see. Obvious secrets (API keys, tokens, private keys) are masked before anything is saved.

## Before you start

| Value | Where to get it |
|---|---|
| **WAIP token** | WAIP → MCP Store → `memory-mcp` → Connection tab. Create your own: it tells Agent Memory who you are. |
| **Memory key** (`sk-mem-…`), only if needed | WeaverAI Memory Fabric panel, https://agent-memory.platform.weaversoft.io → API Key page |

With the WAIP token alone, WAIP vouches for you to Agent Memory (a signed identity on every call), and Agent Memory uses your account: the one you linked when you first signed in to the panel with WeaverAI, or a new one in the `weaversoft` team. If you have an older Agent Memory account, sign in to the panel once with WeaverAI and link it first, or agents get an "isn't linked yet" error.

Until the WAIP platform update that sends this identity is deployed, also paste your memory key. A local server always needs it.

The server URL is preset to production: `https://weaverai-api.platform.weaversoft.io/api/mcp-proxy/memory-mcp`.

## Claude Code

In Claude Code:

```
/plugin marketplace add weaversoftio/WeaverAI-Memory-Fabric
/plugin install agent-memory@weaversoft
```

When asked, keep the server URL as it is, paste your WAIP token (and your memory key only if you need it, see above), and leave agent ID empty unless you own more than one agent. They go into your system's secure credential store.

Restart Claude Code. `/mcp` should list `agent-memory`, and `/hooks` shows the three hooks. Updates: `/plugin marketplace update weaversoft`.

If you added the MCP by hand before (`claude mcp add … agent-memory …`), remove that one: `claude mcp remove agent-memory`.

## Cursor

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/weaversoftio/WeaverAI-Memory-Fabric/main/plugins/agent-memory/cursor/install-cursor.ps1 -OutFile "$env:TEMP\install-cursor.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-cursor.ps1"
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/weaversoftio/WeaverAI-Memory-Fabric/main/plugins/agent-memory/cursor/install-cursor.sh -o /tmp/install-cursor.sh
bash /tmp/install-cursor.sh
```

It asks for your WAIP token. Add `-Key <sk-mem-…>` (`--key` on macOS) if you need your memory key, and `-AgentId <id>` (`--agent-id <id>`) if you own more than one agent.

Restart Cursor. Settings → MCP should show `agent-memory` as connected.

The installer writes, at user level so it applies to every project, and keeps a backup of anything already there:

| File | What it adds |
|---|---|
| `~/.cursor/mcp.json` | the `agent-memory` MCP server |
| `~/.cursor/hooks.json` | `sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse` hooks that send the hook data with `curl` |

Remove it again with `-Uninstall` (`--uninstall`).

## What gets saved

Your memory is **loaded** at the start of every chat, everywhere. **Saving** your conversations (the raw history, L0) is up to you, per project:

- **Off until you say yes.** In a project you haven't decided on, the agent asks you once: *"Should Agent Memory save our conversations in <project>?"* Your answer is kept on your agent in Agent Memory, so it follows you to other machines. Change it any time by telling the agent ("stop saving this project" / "save this project").
- **A project** is the repo's git remote (e.g. `bitbucket.org/weaversoft/agent-memory`), or the folder if there's no remote. Any credentials in the remote URL are removed on your machine before it's sent.
- **`#nomemory`** anywhere in a message: nothing more from that chat is saved. In Claude Code the pause is kept on your machine, so the rest of that chat isn't even sent.
- **Bare acknowledgements** ("ok", "thanks", 👍) are never saved.
- **Raw history is kept 30 days.** The facts extracted from it (L1 and up) stay.

Facts the agent saves on purpose with `memory_add` are separate: they're saved whenever it decides to (or you ask), in any project.

## Check that it works

1. In a project you said yes to, tell the agent something worth remembering, e.g. "our staging database is on port 5433".
2. In the panel → Chat Memory → your agent: the conversation shows up under **L0** right away, and extracted facts under **L1** after a few turns or 10 quiet minutes.
3. Start a new chat and ask about it.

## How it works

```
Claude Code / Cursor ──(own login)──> its usual model
   ├─ MCP tools ──────────────┐  (the model decides)
   └─ hooks ──────────────────┤  (every turn, in projects you said yes to)
                              ▼
   WAIP MCP proxy (your WAIP token → signed X-WAIP-Identity) ──> memory-mcp  /mcp  /hooks/*
                              ▼
   WeaverAI Memory Fabric panel API (verifies the identity → your key, your permissions) ──> memory-core L0 → L1 → L2 → L3
```

| Moment | Claude Code hook | Cursor hook | What happens |
|---|---|---|---|
| chat starts | `SessionStart` | `sessionStart` | profile + scenes (or recent facts) added to the chat, plus this project's saving status (and the one-time question if undecided) |
| you send a message | `UserPromptSubmit` | `beforeSubmitPrompt` | your message saved to L0, if saving is on and the chat isn't paused |
| the agent finishes | `Stop` | `afterAgentResponse` | the reply saved to L0, same conditions |

Saving runs in the background in Claude Code and never blocks a prompt in Cursor: if the memory server is down, you just keep working.

## Local development

Against the local Docker stack (`deploy/global-images` plus a `wamf-memory-mcp` container on port 8097), set the server URL to `http://localhost:8097`, enter `local` as the WAIP token (it is required but unused locally) and set your memory key. In Claude Code you can install from a checkout with `/plugin marketplace add <path to Agent-Memory>`; the Cursor installers take `-Url http://localhost:8097` (`--url`).
