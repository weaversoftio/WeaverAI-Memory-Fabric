# DeepSeek Harness asset import

Imports this machine's dsh **skills / sessions** into the WeaverAI Memory Fabric panel. This one manual is all you need.

Data root: `$DSH_HOME` (default `~/.dsh`). Project root = the nearest ancestor containing `.git`; if there is none, `--workspace` / cwd.

## What gets scanned

**Skill** (for duplicate names the lower rank wins; one level only, no recursive `**/SKILL.md`)

| Rank | Path |
|---|---|
| 100 | `<project root>/.dsh/skills/` |
| 200 | `<project root>/.agents/skills/` |
| 300 | `customSkillDirs` in `settings.yaml`, or `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/` (skips `.system`) |
| 500 | `~/.agents/skills/` (root can be changed with `DSH_AGENTS_HOME`) |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir` (skipped if not set) |

Either a directory `<name>/SKILL.md` or a flat `<name>.md`.

**Memory**: local files are no longer scanned; memory is only extracted from sessions (see below).

**Session**

Recursively `$DSH_HOME/sessions/**/session.jsonl.zstd` (`session.jsonl` when uncompressed). `--workspace` doesn't affect sessions; `--sessions` changes the scan root. Only `user/message` + `assistant/message` are parsed; empty sessions are skipped.

## Prerequisites

Run from the repository root. Needs Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export WAMF_SERVICE_ID=<spaceId>
export WAMF_USER_KEY=<the sk-mem-... key of the agent's owner>
# optional: DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` are required.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. `--source dsh` selects the IDE this manual is for; without it the default `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: first lists what can be imported (skills: number/name/description/source/script count; sessions: id/time range/project path), then asks "import all / import none / import some" (for some, enter numbers or IDs separated by commas/spaces)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without asking)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

# Use a specific project directory
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume state and re-import items already imported)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


