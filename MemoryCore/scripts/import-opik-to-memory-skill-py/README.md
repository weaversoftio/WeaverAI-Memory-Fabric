# Opik → Memory Core Skill import tool (Python version)

**Python standard library only, no third-party dependencies**; runs directly on Python 3.9+.

## Three subcommands

- `list-projects`: only lists Opik projects
- `fetch`: pulls data from Opik and groups it into local session JSON files (doesn't write to core)
- `import`: loads the local session files into Memory Core

**Recommended: keep fetch and import separate**. After fetch you can disconnect from Opik and let import run at its own pace; import resumes by default, so if it dies halfway, a rerun only fills in what's missing.

## How it relates to the TS version (`../import-opik-to-memory-skill/`)

| Dimension | TS version | Python version |
|---|---|---|
| fetch vs load | one step | **two separate steps** (fetch → import) |
| dependencies | Node ≥ 22.16 + `npm install` | Python 3.9+, none |
| load batching | packed by bytes/count | **batched per "conversation turn"** (one user message + the assistant/tool_call/tool_result after it) |
| load pace | as fast as possible | sleeps after each turn (default 3s); global Opik rate limit of 500ms |
| resume | yes | **import has it, per session** |
| extraction output stats | polls `skill/list` until it settles | doesn't check; look in the UI or `/v3/skill/list` |

## Prerequisites

- Python 3.9+
- the Opik REST API reachable
- the Memory Core Gateway business endpoints (`/v3/skill/*`) working
- skill extraction + the LLM running on the Memory Core side (otherwise nothing is produced)
- `team_id` + `agent_id` registered in the metadata layer
  - ⚠️ agent ids are `agt-xxx`, not `apt-xxx`; the `asset_id` you see in metadata `/api/v1/meta/asset/list-accessible` is `skl-*` (the skill primary key); to find the matching `agent_id`, look up `owner_agent_id` with core's `/v3/skill/list`

## Only secrets come from environment variables; everything else is a command-line option

This is deliberate: env vars are easy to get wrong, forget to unset, or leak into other processes. Identity options (`--team-id / --agent-id / --user-id / --service-id / --memory-url / --opik-url`) **must be given explicitly on the command line**, so every run shows which environment it targets.

Secrets are only read from environment variables, never from CLI options (so they don't show up in shell history / `ps aux`):

```bash
export MEMORY_CORE_API_KEY='ck_xxx.xxx'
# only when Opik has authentication enabled:
# export OPIK_API_KEY='...'
# export OPIK_AUTH_SCHEME='Bearer'
```

> `user_id` / `team_id` / `agent_id` / `session_id` must not contain `|` (the Redis queue element separator); the script checks this at startup.

## Usage

### 1. List Opik projects

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py list-projects \
  --opik-url 'http://<opik-host>:5173'
```

No Memory Core options or secrets needed.

### 2. Fetch: pull data from Opik to local files only

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '3367b740' \
  --out-dir ./opik-dump-3367b740
```

- `--project` matches an exact id / exact name / id prefix / name prefix
- the output directory gets one `.json` file per session (`session_id + .json`, invalid characters replaced with `-`)
- the directory also has a `manifest.json` with the project id, trace count, session count and fetch time
- existing files are skipped by default; `--overwrite` replaces them

**Important**: fetch only loads Opik, never Memory Core; the two are decoupled.

### 3. Import: load the local directory into Memory Core

```bash
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx \
  --agent-id agt-xxx \
  --user-id  usr-xxx \
  --task-id  opik-import-2026-08 \
  --concurrency 5 \
  --turn-gap-ms 2000
```

The first run shows a rough ETA:

```
[import] total sessions=87 (done 0, pending 87) total turns=412 pending turns=412
[import] concurrency=5 turn-gap=2000ms → rough ETA ~2m44s (HTTP time not included)
```

While running it prints a progress line for every finished session:

```
[progress] sessions 12/87  turns 68/412  elapsed 34s  ETA ~2m5s
```

Resume state is saved in `--in-dir/.import-state.json` (override with `--state-file`). A rerun after a crash skips the finished sessions; add `--no-resume` to force a full reload.

### Dry run

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --dry-run
```

Sends nothing to core and writes no state; it only runs the grouping logic. A dry run needs the identity options too (the script reads them to validate and compute the ETA).

## Options

### `fetch`

| Option | Default | Description |
|---|---:|---|
| `--project` | **required** | id / name / prefix |
| `--out-dir` | **required** | output directory |
| `--max-traces` | 0 | maximum traces to pull from Opik (0 = no limit) |
| `--max-sessions` | 0 | keep only the first N sessions |
| `--page-size` | 100 | Opik page size |
| `--opik-request-gap-ms` | 500 | minimum gap between Opik requests (protects Opik) |
| `--include-system` | off | keep system messages (dropped by default) |
| `--overwrite` | off | overwrite existing files |

### `import`

| Option | Default | Description |
|---|---:|---|
| `--in-dir` | **required** | the directory fetch produced |
| `--max-sessions` | 0 | load only the first N sessions |
| `--concurrency` | 2 | maximum concurrency across sessions |
| `--turn-gap-ms` | 3000 | gap between turns within a session |
| `--no-force-archive` | off | skip the final force-archive |
| `--dry-run` | off | read only, no writes |
| `--state-file` | `<in-dir>/.import-state.json` | resume state file |
| `--no-resume` | off | ignore the resume state |

## Data flow

```
Opik /projects
    ↓ (pick the project)
Opik /traces?project_id=...   (paged; globally rate limited to 500ms per request)
    ↓
group by thread_id → per thread keep only the trace with the most messages (cumulative snapshot)
    ↓
local JSON files: <out-dir>/<session_id>.json
    ↓ (fetch done; Opik can be disconnected now)
    ↓ (import starts)
read the local files → split each session into "conversation turns"
    ↓
concurrency=N sessions in parallel; turns within a session run in order
    ↓
POST /v3/skill/conversation/add for each turn (same session_id)
    ↓ sleep turn-gap-ms
    ↓
final force-archive → recorded in the resume state
```

**Key points**:
- a session always uses the same `session_id`; each request pushes one turn
- turns within a session are separated by a sleep (default 3s); different sessions run in parallel
- Opik fetching has a global minimum gap (default 500ms)
- import resumes per session; a failed turn within a session logs a warning and continues with the next turn

## Extraction thresholds

The server's `add-handler` archives when any of these is met:

| Condition | Threshold |
|---|---:|
| accumulated `tool_call` count | 10 |
| accumulated bytes | 40 KB |
| bytes in a single request | ≥ 40 KB compresses and archives immediately |

If a session has few tool_calls and little content, only the final `force-archive` archives it; if the extractor decides it's "not worth keeping" → 0 skills. That is a **normal result**.

## Quick check (1 session, verify the pipeline)

```bash
# fetch 1 session
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '019ed0c0' --out-dir /tmp/opik-smoke \
  --max-sessions 1 --max-traces 20

# load it into core
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir /tmp/opik-smoke \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --turn-gap-ms 1000
```

## Known limitations

- no filtering of evaluation data such as SWE-bench (avoid those projects by hand)
- extraction output isn't checked; look in the UI / `/v3/skill/list` afterwards
- a failed turn within a session logs a warning and continues, with no rollback of the whole session. Because resume works per session, not per turn, rerunning a session that already archived will archive it again; if a session had many failed turns, delete its entry from the state file and rerun it
