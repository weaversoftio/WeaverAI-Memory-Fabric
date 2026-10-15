# OpenClaw asset import

Imports this machine's open-source OpenClaw **skills / sessions** into the WeaverAI Memory Fabric panel. This one manual is all you need.


It scans the client's own data, not this project's `~/.openclaw/context-offload/*`.

## What gets scanned

**Skill** (for duplicate names, the user's own overrides the built-in one)

| Priority | Path |
|---|---|
| 1 | `~/.agents/skills/<name>/SKILL.md` |
| 2 | `~/npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md` |

Skills may come with `scripts/` `references/` `assets/` `agents/`. The workspace / `~/.openclaw/skills` / extraDirs are not scanned.

**Memory**: local files are no longer scanned; memory is only extracted from sessions (see below).

**Session** (`$OPENCLAW_STATE_DIR/agents/<id>/sessions/`, default `~/.openclaw`)

Imports the `<sessionId>.jsonl` files one level down. `sessions.json`, `*.trajectory.jsonl`, `*.lock` and sqlite are not scanned.

## Prerequisites

Run from the repository root. Needs Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export WAMF_SERVICE_ID=<spaceId>
export WAMF_USER_KEY=<the sk-mem-... key of the agent's owner>
# optional: OPENCLAW_STATE_DIR / OPENCLAW_WORKSPACE_DIR
```

`--agent-id` / `--team-id` are required; the agent's owner must be the user that `WAMF_USER_KEY` belongs to.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. `--source openclaw` selects the IDE this manual is for; without it the default `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: first lists what can be imported (skills: number/name/description/source/script count; sessions: id/time range/project path), then asks "import all / import none / import some" (for some, enter numbers or IDs separated by commas/spaces)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without asking)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> -y

# Use a specific project directory
tsx agents/asset-import.ts --source openclaw --workspace /path/to/workspace --agent-id <id> --team-id <tid>

# Re-import (ignore resume state and re-import items already imported)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> --force

```


