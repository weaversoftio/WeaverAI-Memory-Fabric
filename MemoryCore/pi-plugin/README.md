# @weaversoft/pi-wamf-client

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that routes Pi
through [WeaverAI Memory Fabric](https://github.com/weaversoftio/WeaverAI-Memory-Fabric)
proxy for team memory: L3 persona, L2 scene index, L0 conversation capture, and
on-demand L0/L1/L2 search.

The plugin carries **only routing + a dynamic per-session `x-conversation-id`
header**. All memory capability is delivered server-side by the proxy
(injected into the system prompt and captured from the response). This keeps
the extension minimal and keeps memory logic in one place. (Scope: routing +
header; no client-side recall/capture.)

## Prerequisites

- Pi installed and on your `PATH`.
- A running WAMF v2 stack (Memory Core + Proxy).
- In the WAMF panel: a **Team** and an **Agent**. A **Task** is optional —
  memory works without one (broad recall); create + link a Task only if you
  want to filter recall to a specific project.

## Configure (env vars, no secrets in files)

| Env var | Required | Default | Notes |
|---|---|---|---|
| `WAMF_PROXY_URL` | no | `http://127.0.0.1:8096` | proxy host:port |
| `WAMF_SPACE_ID` | no | `default` | memory instance id |
| `WAMF_AGENT_SOURCE` | no | `pi` | first-class path; set `codebuddy` to fall back to the CodeBuddy profile for debugging |
| `WAMF_TEAM_ID` | **yes** | — | from the panel (Team) |
| `WAMF_AGENT_ID` | **yes** | — | from the panel (Agent) |
| `WAMF_TASK_ID` | no | — | optional; from the panel (Task linked to the agent). When set, recall narrows to that task; when absent, recall is broad across the agent's memories |
| `WAMF_USER_KEY` | **yes** | — | the **user's** API key (panel → API Key), NOT the admin/gateway key |
| `WAMF_MODEL` | no | `glm-5.2-vision` | must match a model the proxy forwards to |

Set these in your shell or Pi's env block; the plugin reads them at load.

## Install / load

Quick test (throwaway load):

```bash
WAMF_USER_KEY=<your-user-key> WAMF_TEAM_ID=<...> WAMF_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider wamf --model glm-5.2-vision
```

(Add `WAMF_TASK_ID=<...>` only if you want task-scoped recall.)

Auto-discover (global): symlink or copy into `~/.pi/agent/extensions/` and Pi
loads it on startup.

## Verify (integration gate)

Confirm the proxy sees the `pi` agent-source and that memory is wired:

```bash
WAMF_USER_KEY=<your-user-key> WAMF_TEAM_ID=<...> WAMF_AGENT_ID=<...> \
  pi -e ./MemoryCore/pi-plugin --provider wamf --model glm-5.2-vision -p "say OK"
# Then check proxy logs:
docker logs wamf-proxy --tail 30 2>&1 | grep -E "agentSource|write-l0|register directly"
```

Expect `agentSource=pi`, `register directly`, and a `write-l0` line. If you see
`agentSource=codebuddy` (or the default) or no `write-l0`, the base URL or
identity headers are wrong.

## Troubleshooting

- **Use the user's API key, not the admin key.** The proxy validates the
  `Authorization: Bearer` against the user's API key (panel → API Key). The
  admin/gateway key is for internal endpoints, not client routing.
- **`x-task-id` is optional.** Memory works with just team + agent (broad
  recall). Set `WAMF_TASK_ID` only to narrow recall to a specific Task. A
  stale/unknown task id is dropped with a warning and recall broadens — it
  does not block memory.
- **Missing env vars don't block Pi.** If a required env var is unset, the
  extension logs a warning at load and skips registering the `wamf` provider —
  Pi starts normally, just without the WAMF provider available. Set the vars
  and restart Pi to enable it.
- **Fall back to the CodeBuddy profile for debugging.** Set
  `WAMF_AGENT_SOURCE=codebuddy` to route through the existing, battle-tested
  CodeBuddy profile (injection still works; anchoring is coarser). Useful to
  isolate whether an issue is Pi-specific or a proxy/config problem.
