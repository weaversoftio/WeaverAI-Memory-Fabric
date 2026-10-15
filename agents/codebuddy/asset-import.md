# CodeBuddy asset import

Imports this machine's CodeBuddy **skills / sessions** into the WeaverAI Memory Fabric panel. This one manual is all you need.


## What gets scanned

| Type | Path |
|---|---|
| Skill | `~/.codebuddy/skills/*/SKILL.md`; project `<cwd>/.codebuddy/skills/*/SKILL.md` |
| Session | `~/.codebuddy/projects/<project>/*.jsonl` |

`--workspace` changes the project-side path to that directory (the global `~/.codebuddy` is still scanned).

## Prerequisites

Run from the repository root. Needs Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export WAMF_SERVICE_ID=<spaceId>
export WAMF_USER_KEY=<the sk-mem-... key of the agent's owner>
```

`--agent-id` / `--team-id` are required; the agent's owner must be the user that `WAMF_USER_KEY` belongs to.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. `--source codebuddy` selects the IDE this manual is for; without it the default `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: first lists what can be imported (skills: number/name/description/source/script count; sessions: id/time range/project path), then asks "import all / import none / import some" (for some, enter numbers or IDs separated by commas/spaces)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without asking)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> -y

# Use a specific project directory
tsx agents/asset-import.ts --source codebuddy --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume state and re-import items already imported)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> --force

```



