---
name: openclaw-memory-weaverai-setup
description: Installs, configures and verifies the WeaverAI Memory Fabric OpenClaw plugin (@weaversoft/memory-weaverai). Trigger it when the user mentions "WeaverAI Memory Fabric", "install the memory plugin", "configure memory-weaverai", "enable long-term memory/recall", or reports related errors.
version: 1.0.0
---

## Purpose

Give OpenClaw durable local long-term memory (L0→L1→L2→L3) without relying on an external hosted memory service, and take it from installation through configuration to acceptance in one pass.

## When to use

- the user asks to install or enable `memory-weaverai` in OpenClaw
- the user needs to configure recall, extraction, persona, cleanup or other parameters
- the user reports "the plugin is installed but there is no memory / no recall / no vector search"

## When not to use

- the user only wants the memory concept explained, not set up
- the user wants a host other than OpenClaw (confirm the target framework first)

## Standard workflow

### 1) Environment check

First confirm the base versions meet the requirements:

- OpenClaw: `>= 2026.3.13`
- Node.js: `>= 22.16.0`

Run:

```bash
openclaw --version
node -v
```

If a version is too old, upgrade it before continuing.

### 2) Install the plugin

Run the install command:

```bash
openclaw plugins install @weaversoft/memory-weaverai
```

If it's already installed, update it:

```bash
openclaw plugins update memory-weaverai
```

### 3) Write the minimal config

Edit `~/.openclaw/openclaw.json` and make sure it contains:

```json
{
  "memory-weaverai": {
    "enabled": true
  }
}
```

Note: the plugin starts with zero configuration; the basic features run without any other fields.

### 4) Add the recommended config as needed (common in production)

Add these groups according to the user's needs:

- `capture`: conversation capture and retention
- `extraction`: L1 extraction and deduplication
- `pipeline`: L1→L2→L3 scheduling
- `recall`: number of results, threshold, strategy
- `persona`: scene and persona trigger parameters
- `embedding`: vector search config (remote, OpenAI-compatible)

Recommended template:

```json
{
  "memory-weaverai": {
    "capture": {
      "enabled": true,
      "excludeAgents": [],
      "l0l1RetentionDays": 90,
      "cleanTime": "03:00"
    },
    "extraction": {
      "enabled": true,
      "enableDedup": true,
      "maxMemoriesPerSession": 10,
      "model": "provider/model"
    },
    "pipeline": {
      "everyNConversations": 5,
      "enableWarmup": true,
      "l1IdleTimeoutSeconds": 600,
      "l2DelayAfterL1Seconds": 10,
      "l2MinIntervalSeconds": 900,
      "l2MaxIntervalSeconds": 3600,
      "sessionActiveWindowHours": 24
    },
    "recall": {
      "enabled": true,
      "maxResults": 5,
      "scoreThreshold": 0.3,
      "strategy": "hybrid"
    },
    "persona": {
      "triggerEveryN": 50,
      "maxScenes": 15,
      "backupCount": 3,
      "sceneBackupCount": 10,
      "model": "provider/model"
    },
    "embedding": {
      "enabled": true,
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${EMBEDDING_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "conflictRecallTopK": 5
    }
  }
}
```

### 5) Key config rules (to avoid silent failures)

- With `embedding.provider = "none"` vector features are disabled and only the keyword path remains.
- With a remote `provider` (such as `openai` / `deepseek`) you must also provide:
  - `apiKey`
  - `baseUrl`
  - `model`
  - `dimensions`
- If any of these is missing the plugin keeps running but silently falls back to non-vector mode.
- `l0l1RetentionDays`:
  - `0` means no cleanup
  - any other value should be `>=3`
  - values of `1–2` require `allowAggressiveCleanup` to be turned on explicitly

### 6) Restart and verify

Run:

```bash
openclaw gateway restart
```

Check:

- the Gateway log shows lines with the `[memory-wamf]` prefix
- the data directory exists: `~/.openclaw/state/memory-wamf/`
- it contains at least `conversations/`, `records/`, `scene_blocks/`, `vectors.db`

### 7) Smoke test

Run one minimal conversation loop and verify:

1. Talk for 2–3 turns and give memorable information (preferences, constraints, background).
2. Start a new conversation and check that recalled context is injected.
3. In the Agent, call:
   - `wamf_memory_search`
   - `wamf_conversation_search`
4. Confirm they find the content you just produced.

## Troubleshooting quick reference

- No plugin logs: check that `memory-weaverai.enabled` is `true` in `openclaw.json` and that the Gateway was restarted.
- Records but no recall: check `recall.enabled` and whether `scoreThreshold` is too high.
- No vector results: check that the `embedding` quartet (`apiKey/baseUrl/model/dimensions`) is complete.
- Too little history left after aggressive cleanup: check `l0l1RetentionDays` and `allowAggressiveCleanup`.
- Config changed but behaviour didn't: make sure you edited `~/.openclaw/openclaw.json`, and restart the Gateway again.

## Security and compliance

- Treat `apiKey` as sensitive; never spread it in plain text in chat, logs or screenshots.
- Prefer injecting keys through environment variables; keep only placeholders in config examples.
- Only change the `memory-weaverai` section; don't overwrite the user's other plugin configs.

## Definition of Done

Before finishing, all of these must hold:

- the plugin install/update command succeeded
- `openclaw.json` has a valid `memory-weaverai` config
- the Gateway has been restarted
- `[memory-wamf]` logs are visible
- the data directory and key files exist
- at least 1 search tool call returned results

## Hand-off message template

When done you can tell the user:

- `memory-weaverai` is installed and configured, and the Gateway has been restarted.
- The logs and data directory are verified; the memory pipeline is working.
- For further tuning, adjust `recall.scoreThreshold`, `pipeline.everyNConversations`, `persona.triggerEveryN` and the `embedding` model parameters.
