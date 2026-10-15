# Opik → Memory Core import tool

Converts the traces of an Opik project into conversation messages and writes them to L0 through the Memory Core Gateway's `POST /v3/conversation/add`.

## Features

- pages through all Opik projects and all traces of the chosen projects automatically
- selects projects by name or UUID
- recognises common trace structures: `messages`, `conversation`, `history`, `prompt/response`, OpenAI `choices`, etc.
- merges input/output messages, removes overlap, and caps single-message and single-batch size
- checks each session before writing; if more than 40k L0 messages are expected, deduplicates across traces and imports the latest tail snapshot first
- dry run, resume, network retries and pipeline throttling
- secrets are read from environment variables only

## Prerequisites

- Node.js `>= 22.16.0`
- this project's dependencies installed
- the Opik REST API reachable
- a remote Memory Core Gateway with reachable `/health`, `/v3/conversation/add` and `/v3/conversation/query`
- the target `service_id`, `team_id`, `agent_id` and `user_id` decided

Go into the Memory Core directory:

```bash
cd MemoryCore
```

Show all options:

```bash
npm run import:opik -- --help
```

## Opik address and pagination

Configuring just the Opik root address and workspace is recommended:

```bash
export OPIK_URL='http://opik.example.com:5173'
export OPIK_WORKSPACE='default'
```

UI addresses work too:

```text
http://opik.example.com:5173/default/projects?size=25
```

The `size=25` in a UI URL doesn't limit the import. The tool converts it to the `/api/v1/private` API address and reads every page with `page` and `size`; `--page-size` defaults to `100`.

## Configure the remote Memory Core

These addresses are examples only; replace them with your real Gateway address:

```bash
export MEMORY_CORE_URL='http://memory-core.example.com:8423'
export MEMORY_CORE_SERVICE_ID='default'
export MEMORY_CORE_TEAM_ID='team-001'
export MEMORY_CORE_AGENT_ID='agent-001'
export MEMORY_CORE_USER_ID='user-001'
```

Optional task isolation:

```bash
export MEMORY_CORE_TASK_ID='task-001'
```

When no task is needed:

```bash
unset MEMORY_CORE_TASK_ID
```

Enter the API key securely so it never ends up in code or config files:

```bash
read -s "MEMORY_CORE_API_KEY?Memory Core API Key: "
echo
export MEMORY_CORE_API_KEY
```

Check the Gateway:

```bash
curl --fail --silent --show-error "${MEMORY_CORE_URL}/health"
```

## Do a dry run first

A dry run reads the real Opik data and converts the traces, but writes nothing to Memory Core or the state file:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --dry-run
```

`--project` takes both project names and UUIDs; repeat it or separate values with commas:

```bash
npm run import:opik -- \
  --project 'project-a' \
  --project '019fb2e2-16a9-717d-98a8-0cd2e1bef87e' \
  --dry-run
```

Without `--project` every project in the workspace is processed. With many projects, validate a small batch first with a specific project and `--max-traces`.

## Real import

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --state-file './opik-import-remote-state.json'
```

On success it prints:

```text
[import] project=... trace=... accepted=...
[done] seen_traces=5 imported_traces=5 ... imported_messages=...
```

What the tool actually calls:

```text
POST <MEMORY_CORE_URL>/v3/conversation/add
```

Where the data lands is decided by:

- `x-wamf-service-id`: `MEMORY_CORE_SERVICE_ID`
- `team_id`: `MEMORY_CORE_TEAM_ID`
- `agent_id`: `MEMORY_CORE_AGENT_ID`
- `user_id`: `MEMORY_CORE_USER_ID`
- `task_id`: `MEMORY_CORE_TASK_ID`, optional
- `session_id`: generated stably from the Opik project ID and the `thread_id`/trace ID

Each message gets the original Opik time written to both:

- `timestamp`: when the message actually happened
- `recorded_at`: the L0 ordering time, stored as the L0 store's `recorded_at_ms`

So when the panel sorts by `recorded_at_ms desc` it shows the Opik history times, not when the import ran. Normal Memory Core writes that don't pass `recorded_at` explicitly still use the server's receive time.

## Large session protection

The default is `--max-session-messages 40000`. This counts L0 messages, not user/assistant "rounds"; 40k messages is about 20k standard question/answer rounds, below the known risk limit of 50k per session.

The tool first groups the traces it will process by target `session_id`. If one session is expected to exceed the limit:

1. it merges the accumulated conversation in trace order, removing history from earlier traces that repeats in later ones;
2. keeps only the latest N deduplicated messages;
3. writes them first to a separate tail-snapshot session with an ID like `original-session:t40000:<snapshot hash>`;
4. stops writing that source session's old traces one by one, so no single new session goes over the configured limit.

The snapshot ID changes with the tail content. When the source later gets new messages, a new snapshot session is created rather than appending to the old session and breaking the limit again.

Dry run to check for large sessions:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy tail \
  --dry-run
```

If truncation isn't allowed and you want it to stop when a session is over the limit:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy error \
  --dry-run
```

`--max-session-messages 0` turns the protection off, but that's not recommended for sessions that may exceed 50k L0 messages.

## Resume

Resume is on by default. Every successful batch is written to `--state-file` immediately, and running the same command again skips the batches already done:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --state-file './opik-import-remote-state.json'
```

Ignore the existing state:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --no-resume
```

`--no-resume` can import duplicates; use it only when you really mean to re-import. The state file has `0600` permissions and never stores the API key.

## Pipeline strategy

By default it waits for L1 to be idle after every 20 batches, and at the end waits for L1/L2/L3 to be idle.

If memory extraction is off in the target environment and you only need L0:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --wait-every 0 \
  --no-final-wait \
  --state-file './opik-import-remote-state.json'
```

## Check the imported data

```bash
curl --fail --silent --show-error \
  -X POST "${MEMORY_CORE_URL}/v3/conversation/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${MEMORY_CORE_API_KEY}" \
  -H "x-wamf-service-id: ${MEMORY_CORE_SERVICE_ID}" \
  --data "$(cat <<JSON
{
  \"team_id\": \"${MEMORY_CORE_TEAM_ID}\",
  \"agent_id\": \"${MEMORY_CORE_AGENT_ID}\",
  \"user_id\": \"${MEMORY_CORE_USER_ID}\",
  \"limit\": 100,
  \"offset\": 0
}
JSON
)"
```

## Opik authentication

A self-hosted Opik may need no authentication by default. When it's enabled:

```bash
read -s "OPIK_API_KEY?Opik API Key: "
echo
export OPIK_API_KEY
export OPIK_AUTH_SCHEME='Bearer'
```

When `OPIK_AUTH_SCHEME` is empty, `OPIK_API_KEY` is sent as the `Authorization` header unchanged.

## Common options

| Option | Default | Description |
|---|---:|---|
| `--project` | all projects | project name or UUID; repeat or comma-separate |
| `--page-size` | `100` | items per Opik API page |
| `--max-traces` | `0` | maximum traces to process this run; `0` means no limit |
| `--max-session-messages` | `40000` | maximum L0 messages written per target session; `0` disables the protection |
| `--large-session-strategy` | `tail` | keep the latest tail when over the limit; `error` stops instead |
| `--state-file` | `.opik-memory-import-state.json` | resume state file |
| `--dry-run` | off | fetch and convert only, no writes |
| `--no-resume` | off | ignore the resume state; may import duplicates |
| `--include-system` | off | turn system/developer messages into prefixed user messages |
| `--wait-every` | `20` | wait for L1 every N write requests; `0` disables |
| `--no-final-wait` | off | don't wait for L1/L2/L3 to be idle at the end |
| `--timeout-ms` | `30000` | timeout per HTTP request |
| `--retries` | `4` | retries for network errors, 429 and 5xx |

## Verified end to end

The tool has been verified end to end against the real Opik API and an isolated local Memory Core:

1. paged through Opik projects and traces
2. converted 5 traces into 15 L0 messages
3. wrote them with `/v3/conversation/add`
4. read the 15 messages back with `/v3/conversation/query`
5. a repeat run hit the resume state and wrote 0
6. the SQLite and JSONL mirrors had the same counts on disk
