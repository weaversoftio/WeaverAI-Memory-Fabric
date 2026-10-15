# Hermes

> agentSource: `hermes` | protocol: OpenAI Chat Completions | session init: header preselection (no interactive form)
>
> Importing local history into the WeaverAI Memory Fabric panel: see the [asset import manual](./asset-import.md).

---

## 1. Client configuration

Hermes is configured through the **config file** `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:8096/hermes/<spaceId>
  api_key: <the business user's sk-mem-... user_key>
  default_headers:
    x-team-id: <team_id from the panel>
    x-agent-id: <agent_id from the panel>
    x-task-id: <task_id from the panel>
    x-conversation-id: <your own conversation identifier>
```

Fields:
- `base_url`: proxy address + `/hermes/<spaceId>`; `default` is the memory instance ID
- `api_key`: the business user's `user_key` (from the panel)
- `x-team-id` / `x-agent-id` / `x-task-id`: from the matching panel pages
- `x-conversation-id`: your own conversation identifier (see §6 known limitations below)

Request path: `POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| only | `x-conversation-id` (set statically by the user in the config file) |

⚠️ Hermes doesn't manage session IDs; the user has to change `x-conversation-id` by hand for each new conversation.

---

## 3. Session init

### ⚠️ Key difference: header preselection only, no interactive form

Hermes **doesn't support interactive forms** (the client can't answer a function_call returned by the proxy).  
Session registration relies entirely on headers sent with the request:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | task ID | ✅ (current version) |
| `x-conversation-id` | conversation identifier | ✅ |

**Handling**:
- all four headers present and valid → the session is registered directly and assets are injected
- any of them missing → session bypass (pass-through, no injection)

### No plan mode / default mode

Hermes has no plan/default mode. Either the headers are complete and the full chain runs, or it bypasses.

---

## 4. Request classification

Every request is **main**. Hermes has no auxiliary requests.

---

## 5. Injection profile

Same as CB: XML structure injected into `messages[0].content` (the system message).

---

## 6. Known limitations

### `x-task-id` is currently required

The proxy's header preselection needs all three IDs to register the session. Without `x-task-id` the proxy tries to show the form, but Hermes can't answer it → session bypass → no memory injection.

**Impact**:
- the user has to create a task in the panel first and get its task_id
- switching tasks means editing the config file by hand

### `x-conversation-id` has to be managed by hand

- all requests with the same conversation ID share one session
- change it by hand for every new conversation (otherwise the previous session state carries over)
- some clients don't send the extra headers on the requests that follow a tool call → those turns skip injection

---

## 7. FAQ

**Q: Memory injection doesn't work?**  
A: Check that all four header values are filled in and correct. Any missing/wrong value causes a session bypass.

**Q: How do I get the team_id / agent_id / task_id?**  
A: Log in to the panel → the matching page → the ID field in the details. Or query the panel API `team/list`, `agent/list`, `task/list`.

**Q: What if I don't want to bind a task?**  
A: It's required in the current version. You can set `sessionInit.defaultTaskId: "no-task"` in the proxy `config.yaml` and use that fixed value.
