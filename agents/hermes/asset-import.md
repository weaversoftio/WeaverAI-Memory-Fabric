# Hermes asset import

Imports this machine's Hermes Agent **skills / sessions** into the WeaverAI Memory Fabric panel. This one manual is all you need.


Data root: `$HERMES_HOME` (default `~/.hermes`). Sessions are read from SQLite, which needs **Node >= 22** (`node:sqlite`).

## What gets scanned

**Skill** (for duplicate names the global one overrides the repository's built-in one; any subdirectory containing `SKILL.md`, deeper categories such as `mlops/inference/llama-cpp` allowed)

| Priority | Path |
|---|---|
| 1 | `$HERMES_HOME/skills/<category>/<name>/SKILL.md` |
| 2 | `<hermes-agent repository>/skills/` |
| 3 | `<hermes-agent repository>/optional-skills/` |

Repository root: `HERMES_AGENT_ROOT`, otherwise `$HERMES_HOME/hermes-agent`. `HERMES_BUNDLED_SKILLS` / `HERMES_OPTIONAL_SKILLS` are honoured too.

Not scanned: project `.hermes/skills` / `.agents/skills`, `skills.external_dirs`, `.hub`, pending, `SKILL.md` files nested inside `references/`.

**Memory**: local files are no longer scanned; memory is only extracted from sessions (see below).

**Session**

| Storage | Path | Imported? |
|---|---|---|
| main database | `$HERMES_HOME/state.db` | yes: `sessions` metadata + `user`/`assistant` rows of `messages` |
| raw dumps | `$HERMES_HOME/sessions/request_dump_*.json` | no |

`session_{sid}.json` and `moa-traces/` are not scanned. `--workspace` doesn't restrict sessions. Below Node 22 the session scan is skipped.

## Prerequisites

Run from the repository root:

```bash
export PANEL_URL=http://127.0.0.1:8123
export WAMF_SERVICE_ID=<spaceId>
export WAMF_USER_KEY=<the sk-mem-... key of the agent's owner>
# optional: HERMES_HOME / HERMES_AGENT_ROOT
```

`--agent-id` / `--team-id` are required. If the skills are in the repository's `optional-skills/`, point `--workspace` at the hermes-agent repository root or set `HERMES_AGENT_ROOT`.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. `--source hermes` selects the IDE this manual is for; without it the default `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: first lists what can be imported (skills: number/name/description/source/script count; sessions: id/time range/project path), then asks "import all / import none / import some" (for some, enter numbers or IDs separated by commas/spaces)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without asking)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> -y

# Use a specific project directory
tsx agents/asset-import.ts --source hermes --workspace /path/to/hermes-agent --agent-id <id> --team-id <tid>

# Re-import (ignore resume state and re-import items already imported)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> --force

```


