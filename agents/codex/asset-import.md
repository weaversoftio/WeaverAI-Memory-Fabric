# Codex asset import

Imports this machine's Codex **skills / sessions** into the WeaverAI Memory Fabric panel. This one manual is all you need.


Data root: `$CODEX_HOME` (default `~/.codex`).

## What gets scanned

| Type | Path |
|---|---|
| Skill | USER `$HOME/.agents/skills/*/SKILL.md`; `.agents/skills` from the git root down to cwd; ADMIN `/etc/codex/skills` |
| Session | `$CODEX_HOME/sessions/**/*.jsonl` (`YYYY/MM/DD/rollout-*.jsonl`) |

Not scanned: `~/.codex/skills`, a top-level `skills/` in the repository, `plugins/cache`, `memories/` inside the repository.

`--sessions <dir>` scans that location's `.jsonl` and Responses `.json` files instead. Without `--sessions`, `$CODEX_HOME/sessions` is scanned automatically.

## Prerequisites

Run from the repository root. Needs Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export WAMF_SERVICE_ID=<spaceId>
export WAMF_USER_KEY=<the sk-mem-... key of the agent's owner>
# optional: export CODEX_HOME=/path/to/.codex
```

`--agent-id` / `--team-id` are required; the agent's owner must be the user that `WAMF_USER_KEY` belongs to.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. `--source codex` selects the IDE this manual is for; without it the default `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: first lists what can be imported (skills: number/name/description/source/script count; sessions: id/time range/project path), then asks "import all / import none / import some" (for some, enter numbers or IDs separated by commas/spaces)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without asking)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> -y

# Use a specific project directory
tsx agents/asset-import.ts --source codex --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Use a specific past-session directory/file (overrides the automatic scan)
tsx agents/asset-import.ts --source codex --sessions /path/to/sessions --agent-id <id> --team-id <tid>

# Re-import (ignore resume state and re-import items already imported)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> --force

```



