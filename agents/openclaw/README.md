# OpenClaw

> agentSource: `openclaw` | protocol: OpenAI Chat Completions | session init: header preselection (no interactive form)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

OpenClaw is configured through the `models.providers` section of the **config file** `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<the business user's sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id from the panel>",
          "x-agent-id": "<agent_id from the panel>",
          "x-task-id": "<task_id from the panel>",
          "x-conversation-id": "<your own conversation identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Fields:
- `baseUrl`: proxy address + `/openclaw/<spaceId>`; `default` is the memory instance ID
- `apiKey`: the business user's `user_key` (from the panel)
- `api`: must be `"openai-completions"`
- `headers`: must include `x-team-id`, `x-agent-id`, `x-task-id`, `x-conversation-id`
- `models[].id`: must match a model ID configured for the proxy's upstream
- `allowPrivateNetwork: true`: allows internal network addresses

Request path: `POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| only | `x-conversation-id` (set statically by the user in the config file) |

As with Hermes, OpenClaw doesn't manage session IDs; change it by hand.

---

## 3. Session init

### ⚠️ Key difference: header preselection only, no interactive form

OpenClaw behaves exactly like Hermes: **no interactive forms**; session registration relies on headers:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | task ID | ✅ (current version) |
| `x-conversation-id` | conversation identifier | ✅ |

**Handling**:
- all four headers present and valid → the session is registered directly and assets are injected
- any of them missing → session bypass (pass-through, no injection)

---

## 4. Request classification

Every request is **main**. OpenClaw has no auxiliary requests.

---

## 5. Injection profile

Same as CB: XML structure injected into `messages[0].content` (the system message).

---

## 6. Known limitations

Exactly the same as Hermes:

### `x-task-id` is currently required

Without it the session bypasses and memory injection doesn't happen.  
Workaround: set `sessionInit.defaultTaskId: "no-task"` in the proxy and use that fixed value.

### `x-conversation-id` has to be managed by hand

- requests with the same ID share a session; change the value by hand for new conversations
- some turns that follow a tool call may not carry the headers → those turns skip injection

---

## 7. FAQ

**Q: How is it different from Hermes?**  
A: To the proxy they behave identically (both header preselection + OpenAI Chat). The only differences are the client config file format (YAML vs JSON) and the agentSource tag.

**Q: Is it OK to set cost to 0 in models?**  
A: Yes. OpenClaw uses cost for client-side budget calculations; through the proxy the real billing happens upstream, so 0 on the client side doesn't affect anything.

**Q: What is `allowPrivateNetwork: true`?**  
A: By default OpenClaw refuses to call internal network addresses (a security policy). This setting is needed to reach a proxy on `127.0.0.1` or an internal IP.
