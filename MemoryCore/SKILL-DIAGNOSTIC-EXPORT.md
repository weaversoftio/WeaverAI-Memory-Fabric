---
name: openclaw-diagnostic-export
description: Helps the user export on-site diagnostic data for OpenClaw + the memory-weaverai (formerly memory-wamf) memory plugin, for troubleshooting. Trigger it when the user mentions "export diagnostic data", "export diagnostic", "on-site data", "troubleshoot", "export logs", "collect on-site data" or "package on-site data".
version: 1.0.0
---

## Purpose

Package the OpenClaw logs, the memory plugin data (L0–L3) and a redacted config into a local archive, which the user reviews and then sends to the development team by hand for troubleshooting.

> **About the name**: the plugin was renamed from `@wamf/memory-wamf` to `@weaversoft/memory-weaverai`, but the data directory is still `~/.openclaw/memory-wamf/` (hard-coded). Every reference to the `memory-wamf` directory in this skill means that data directory path and has nothing to do with the plugin ID.

## Export workflow

### Step 1: check the environment

Before exporting, check that the OpenClaw working directory exists and is accessible:

```bash
# find the working directory (priority: env var > ~/.openclaw > ~/.clawdbot)
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
[ -d "$OPENCLAW_DIR" ] || OPENCLAW_DIR="$HOME/.clawdbot"
ls -la "$OPENCLAW_DIR/" 2>/dev/null && echo "✅ found: $OPENCLAW_DIR" || echo "❌ OpenClaw working directory not found"
```

Check the memory-wamf subdirectory exists:

```bash
ls -la "$OPENCLAW_DIR/memory-wamf/" 2>/dev/null
```

### Step 2: run the export script

Run the export script in the project's `scripts/` directory:

```bash
bash scripts/export-diagnostic.sh
```

> The script is the project's `scripts/export-diagnostic.sh`. If you run it through `pnpm` or another way, make sure the working directory is the project root.

By default the script writes the archive to `~/Downloads/openclaw-diagnostic-<timestamp>.tar.gz`.

To use another output directory:

```bash
bash scripts/export-diagnostic.sh /tmp
```

### Step 3: check the result

When the script finishes, check the output:

1. **The archive exists**: the script prints the archive path and size at the end
2. **Explain to the user what it contains**:

| File/directory | Contents | Privacy risk |
|-----------|------|---------|
| `env-info.txt` | OS version, OpenClaw version, directory layout, disk usage | low |
| `logs/` | OpenClaw gateway logs + rolling logs (last 3 days, at most 5000 lines per file) | low |
| `memory-wamf/` | all memory plugin data: L0 conversations, L1 memories, L2 scenes, L3 persona, SQLite database, checkpoint | **high**: contains the user's original conversations |
| `openclaw-config-redacted.json` | redacted config (API keys/tokens/passwords/secrets removed; models/channels/env replaced as a whole) | low |
| `plugins-info.txt` | installed plugins and versions | low |

3. **Remind the user**:
   - the config file was redacted automatically; API keys, tokens and other secrets are replaced with `***REDACTED***`
   - **the memory data (memory-wamf/) contains the user's original conversations**; confirm it can be shared before sending
   - the archive stays local and **is never uploaded automatically**; the user sends it to the development team by hand

### Step 4: tell the user what's next

When the export is done, tell the user:

1. the archive is saved locally (print the exact path)
2. review the contents, then send it to the development team by chat/email or similar
3. if only part of the data is needed (e.g. only logs or only the config), unpack it and send just those parts

## What gets exported

### OpenClaw log locations

| Log type | Path | Description |
|---------|------|------|
| gateway stdout | `~/.openclaw/logs/gateway.log` | gateway daemon standard output |
| gateway stderr | `~/.openclaw/logs/gateway.err.log` | gateway daemon error output |
| rolling log | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | rolled by date, JSON Lines, cleaned up after 24h |
| config audit | `~/.openclaw/logs/config-audit.jsonl` | audit records of config writes |
| command log | `~/.openclaw/logs/commands.log` | command event log (optional hook) |

### Memory plugin data layout

```
~/.openclaw/memory-wamf/
├── conversations/          — L0 raw conversations (daily JSONL shards)
├── records/                — L1 structured memories (daily JSONL shards)
├── scene_blocks/           — L2 scene Markdown files
├── persona.md              — L3 user profile
├── vectors.db              — SQLite database (vectors + full-text index)
├── .metadata/              — checkpoint, scene_index.json
└── .backup/                — rolling backups
```

### Config redaction rules

The export script redacts `openclaw.json` as follows:

| Rule | Handling |
|------|---------|
| field names matching `apiKey/token/password/secret/credential` with a string value | replaced with `***REDACTED(Nchars)***` |
| SecretRef objects (with source/provider/id) | id replaced with `***REDACTED***` |
| top-level `models`, `secrets`, `channels`, `env` blocks | replaced as a whole with `***REDACTED_SECTION***` |
| token/password under `gateway.auth` | replaced with `***REDACTED***` |
| all other fields (including the full `plugins` config) | **kept as is** (the plugin config is what troubleshooting focuses on) |

## Manual export (fallback when the script can't run)

If the export script can't run (e.g. Node.js is unavailable), collect the data by hand:

```bash
# 1. create the export directory
EXPORT_DIR=~/Downloads/openclaw-diagnostic-$(date +%Y%m%d-%H%M%S)
mkdir -p "$EXPORT_DIR"

# 2. copy the logs
cp -r ~/.openclaw/logs/ "$EXPORT_DIR/logs/" 2>/dev/null
cp /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log "$EXPORT_DIR/" 2>/dev/null

# 3. copy the memory plugin data
cp -r ~/.openclaw/memory-wamf/ "$EXPORT_DIR/memory-wamf/" 2>/dev/null

# 4. redact the config by hand (⚠️ you must delete the sensitive fields yourself!)
# copy the config and use an editor to delete the models/secrets/channels blocks and every apiKey/token value
cp ~/.openclaw/openclaw.json "$EXPORT_DIR/openclaw-config-NEEDS-MANUAL-REDACTION.json"

# 5. package
cd ~/Downloads && tar -czf "$EXPORT_DIR.tar.gz" "$(basename $EXPORT_DIR)"

echo "⚠️ Check the config and delete the sensitive information by hand before sending!"
```

## Troubleshooting leads

With the exported data, the development team usually looks at:

| Area | File | Key information |
|---------|---------|---------|
| is the plugin loaded | search `logs/` for `[memory-wamf]` | plugin registration and config parsing logs (note: the log tag is still `[memory-wamf]`, unrelated to the plugin ID) |
| does memory recall work | search `logs/` for `[recall]` | search strategy, latency, hit count |
| is L1 extraction triggered | search `logs/` for `[pipeline]` | scheduling triggers, L1/L2/L3 run status |
| is vector search available | `plugins.entries` in `openclaw-config-redacted.json` | whether the embedding config is right |
| data size/disk usage | `env-info.txt` | du output, file counts |
| checkpoint state | `memory-wamf/.metadata/recall_checkpoint.json` | progress, cursors, counters |
