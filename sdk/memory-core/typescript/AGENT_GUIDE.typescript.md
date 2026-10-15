# Agent integration guide (TypeScript)

This guide explains how to plug `@weaversoft/memory-fabric-sdk-ts` into an AI Agent for **WeaverAI Memory Fabric**. New integrations should use the v3 strict-isolation client (`@weaversoft/memory-fabric-sdk-ts/v3`); the v2 compatibility client is still exported from the package root. The SDK API quick reference is in [`README.md`](./README.md); this guide is about **how to put the APIs together into long-term memory**.

---

## The four things an integration does

```
user input  →  ① recall (inject into the prompt) → LLM → ② capture (write L0)
                            ↑
                  ③ tools: let the LLM look things up itself
                            ↑
                  ④ graceful degradation: failures never break the main flow
```

---

## 0. Initialisation

```typescript
import { MemoryClient } from "@weaversoft/memory-fabric-sdk-ts/v3";

const client = new MemoryClient({
  endpoint: "https://your-memory-gateway",
  apiKey: process.env.MEMORY_API_KEY!,
  serviceId: "your-instance-id",
  teamId: "team-xxx",
  agentId: "agt-xxx",
  userId: "usr-xxx",
  sessionId: "session-xxx", // optional; without it L0/L1 aggregate across sessions
});
```

Note: **pass a config object**, not a bare transport (`new MemoryClient(transport, isolation)` is only for mocking in unit tests).

`serviceId` sets the memory instance isolation; `teamId/agentId/userId/sessionId` set the v3 data-plane isolation. For agent-level recall across sessions, use `client.withIsolation({ sessionId: null })`.

---

## 1. Recall

Before the user message goes to the LLM, fetch three kinds of memory in parallel and put them into the system prompt.

```typescript
async function recall(client: MemoryClient, userQuery: string) {
  const [l1, persona, scenes] = await Promise.allSettled([
    client.searchAtomic({ query: userQuery, limit: 5 }),
    client.readCore(),                              // L3 user profile
    client.listScenarios({}),                       // L2 scene index
  ]);

  const l1Items = l1.status === "fulfilled" ? l1.value.items : [];
  const personaText = persona.status === "fulfilled" ? persona.value.content : null;
  const sceneList = scenes.status === "fulfilled" ? scenes.value.entries : [];

  return formatPrompt(l1Items, personaText, sceneList);
}
```

`Promise.allSettled` is the key: if any branch times out or fails, the other two results are still used and the main conversation isn't affected.

### Two prompt sections

- **prependContext (dynamic)**: the L1 recall results; they change every turn and go before the user message.
- **appendSystemContext (stable)**: persona + scene index + tool usage guide, at the end of the system prompt, to hit the KV cache. _(Open question: even at the end of the system prompt this may still cause KV cache misses; needs more discussion.)_

```typescript
function formatPrompt(l1, persona, scenes) {
  const prepend = l1.length > 0
    ? `<relevant-memories>\n${l1.map(m => `- [${m.type}] ${m.content}`).join("\n")}\n</relevant-memories>`
    : undefined;

  const parts: string[] = [];
  if (persona) parts.push(`<user-persona>\n${persona}\n</user-persona>`);
  if (scenes.length > 0) {
    parts.push("## Scene Navigation\n*Use wamf_read_file to read the details of these scenes*");
    parts.push(scenes.map(s => `- \`${s.path}\``).join("\n"));
  }
  parts.push(MEMORY_TOOLS_GUIDE);  // see below

  return { prepend, append: parts.join("\n\n") };
}
```

> Implementation note: in the `before_prompt_build` hook, **cache the original user text** (the clean version, without the injected recall); the capture stage needs it later. See section 2.

---

## 2. Capture

After an agent turn finishes (the `agent_end` hook), clean the new user/assistant messages of that turn and write them back to L0.

```typescript
async function capture(client: MemoryClient, ctx: {
  sessionKey: string;
  rawMessages: any[];                  // the full message history from the framework
  originalUserText: string;            // clean user text cached during recall
  originalUserMessageCount: number;    // message count cached during recall
}) {
  // ① positional slice: keep only this turn's new messages
  const newMessages = ctx.rawMessages.slice(ctx.originalUserMessageCount);

  // ② extract user/assistant, dropping tool calls / system / multimodal noise
  const extracted = extractUserAssistant(newMessages);

  // ③ swap the recall-polluted user message back to the original
  for (const m of extracted) {
    if (m.role === "user" && m.timestamp === newMessages[0]?.timestamp) {
      m.content = ctx.originalUserText;
      break;
    }
  }

  // ④ text cleanup: drop base64 images and code blocks, filter out very short / symbol-only text
  const cleaned = extracted
    .map(m => ({ ...m, content: sanitize(m.content) }))
    .filter(m => m.content.trim().length > 5);

  if (cleaned.length === 0) return;

  // ⑤ submit
  await client.addConversation({
    session_id: ctx.sessionKey,
    messages: cleaned.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp).toISOString(),
    })),
  });
}
```

### Why replace the "polluted user message"

Recall prepends a `<relevant-memories>...</relevant-memories>` block to the user message. If that isn't restored to the original text before writing L0, the next recall searches/embeds based on the polluted text, creating a **feedback loop** that makes memory messier and messier.

### Why slice by position

`agent_end` gives you the **full history**, not just this turn's additions. Sending all of it rewrites past messages. Note the message count N in `before_prompt_build`; in `agent_end`, `messages.slice(N)` is what's new this turn.

---

## 3. Exposing tools

Memory injected through the prompt alone is limited. Register three more tools so the LLM can look things up itself:

| Tool | When to use | Implementation |
|---|---|---|
| `wamf_memory_search` | find structured preferences/facts | `client.searchAtomic({ query, limit })` |
| `wamf_conversation_search` | find original conversation snippets | `client.searchConversation({ query, limit })` |
| `wamf_read_file` | read a full scene / the core memory | `client.readScenario({ path })` / `client.readCore()` (served by the Gateway) |

Say clearly in the system prompt when to call them, with a call limit:

```
## Memory tools
- wamf_memory_search: search structured memory (user preferences, rules, past events)
- wamf_conversation_search: search the original conversation text
- wamf_read_file: read scene files (use the paths listed in Scene Navigation)

⚠️ At most 3 calls of memory_search + conversation_search combined per turn.
```

Without a limit the LLM searches over and over at random.

---

## 4. Graceful degradation

If the memory service is down, **the main conversation must not go down with it**. Three rules:

1. **Recall** uses `Promise.allSettled`, so one failing branch doesn't affect the others.
2. **Capture** is wrapped in try/catch; failures are only logged:
   ```typescript
   try { await capture(...); }
   catch (e) { logger.warn(`capture failed: ${e.message}`); }
   ```
3. **Tools** return an error message string instead of throwing, so the LLM sees "memory unavailable" and keeps chatting.

---

## 5. Error handling

A non-zero code throws `WAMFError`:

```typescript
import { WAMFError } from "@weaversoft/memory-fabric-sdk-ts";

try {
  await client.readFile("scene_blocks/x.md");
} catch (e) {
  if (e instanceof WAMFError) {
    if (e.code === 404) {
      // the file doesn't exist; normal
    } else {
      logger.warn(`memory error code=${e.code} request_id=${e.requestId}`);
    }
  }
}
```

The server logs the `requestId` too; give it to the backend team when debugging.

---

## 6. Performance tips

- **Total recall budget < 200ms**: run the three branches in parallel, use what comes back fastest, drop what times out.
- **Keep the prompt injection small**: L1 ≤ 5 items, list scene paths only (not their content), one persona. Let the LLM use the tools when it needs more detail.
- **Session granularity**: `sessionKey` is the partition key of the L0 conversation; use a stable id for long conversations (user id + conversation id), not a new one every turn.

---

## 7. Management plane: Knowledge / metadata

Everything above is `MemoryClient` (the data plane: reading and writing memory). If you also need to **manage** the metadata of Knowledge sources (wiki / code-graph), or manage users/teams/agents/tasks/assets, use `MetadataClient`:

```typescript
import { MetadataClient } from "@weaversoft/memory-fabric-sdk-ts";

const meta = new MetadataClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: process.env.MEMORY_API_KEY,
  serviceId: "your-instance-id",
});

// register / list / rename / delete Knowledge entities (management-plane CRUD, see README.md)
await meta.createKnowledge({ knowledge_id: "wiki-1", type: "wiki", service_url: "http://ks:8421/v3", name: "Wiki", team_id: "team-1" });
await meta.listKnowledge({ team_id: "team-1", type: "wiki" });
```

Note: `MetadataClient` only does metadata CRUD. Actually searching wiki content, reading pages and syncing repositories goes through the Knowledge Service data plane (the `:8421` that `service_url` points at), which is a separate set of endpoints outside this SDK.
