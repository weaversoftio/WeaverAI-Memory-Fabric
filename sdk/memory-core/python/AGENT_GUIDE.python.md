# Agent integration guide (Python)

This guide explains how to plug `weaverai-memory-fabric-sdk-python` into an AI Agent for **WeaverAI Memory Fabric**. The quick reference for the SDK's 14 APIs is in [`README.md`](./README.md); this guide is about **how to put them together into long-term memory**.

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

```python
from weaverai_memory_fabric import MemoryClient, AsyncMemoryClient

# sync
client = MemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
)

# async (recommended for Agents)
async with AsyncMemoryClient(
    endpoint="https://your-memory-gateway",
    api_key=os.environ["MEMORY_API_KEY"],
    service_id="your-instance-id",
) as client:
    ...
```

`service_id` sets the isolation granularity of the memory space: the same id shares data, different ids are fully isolated. Agents almost always use async; don't use the sync version (it blocks the event loop).

---

## 1. Recall

Before the user message goes to the LLM, fetch three kinds of memory in parallel and put them into the system prompt.

```python
import asyncio

async def recall(client: AsyncMemoryClient, user_query: str) -> dict:
    l1, persona, scenes = await asyncio.gather(
        client.search_atomic(query=user_query, limit=5),
        client.read_core(),                            # L3 user profile
        client.list_scenarios(),                       # L2 scene index
        return_exceptions=True,                        # key: one failing branch doesn't affect the others
    )

    l1_items = l1["items"] if not isinstance(l1, Exception) else []
    persona_text = persona["content"] if not isinstance(persona, Exception) else None
    scene_list = scenes["entries"] if not isinstance(scenes, Exception) else []

    return format_prompt(l1_items, persona_text, scene_list)
```

`asyncio.gather(..., return_exceptions=True)` is the key: if any branch times out or fails, the other two results are still used and the main conversation isn't affected.

### Two prompt sections

- **prepend_context (dynamic)**: the L1 recall results; they change every turn and go before the user message.
- **append_system_context (stable)**: persona + scene index + tool usage guide, at the end of the system prompt, which is friendly to the KV cache. _(Open question: even at the end of the system prompt this may still cause KV cache misses; needs more discussion.)_

```python
def format_prompt(l1_items, persona, scenes) -> dict:
    prepend = None
    if l1_items:
        lines = [f"- [{m['type']}] {m['content']}" for m in l1_items]
        prepend = "<relevant-memories>\n" + "\n".join(lines) + "\n</relevant-memories>"

    parts = []
    if persona:
        parts.append(f"<user-persona>\n{persona}\n</user-persona>")
    if scenes:
        parts.append("## Scene Navigation\n*Use wamf_read_file to read the details of these scenes*")
        parts.extend(f"- `{s['path']}`" for s in scenes)
    parts.append(MEMORY_TOOLS_GUIDE)  # see below

    return {"prepend": prepend, "append": "\n\n".join(parts)}
```

> Implementation note: during recall, **cache the original user text** (the clean version, without the injected recall); the capture stage needs it later. See section 2.

---

## 2. Capture

After an agent turn finishes, clean the new user/assistant messages of that turn and write them back to L0.

```python
async def capture(
    client: AsyncMemoryClient,
    session_key: str,
    raw_messages: list,                  # the full message history from the framework
    original_user_text: str,             # clean user text cached during recall
    original_user_message_count: int,    # message count cached during recall
):
    # ① positional slice: keep only this turn's new messages
    new_messages = raw_messages[original_user_message_count:]

    # ② extract user/assistant, dropping tool calls / system / multimodal noise
    extracted = extract_user_assistant(new_messages)

    # ③ swap the recall-polluted user message back to the original
    for m in extracted:
        if m["role"] == "user" and m["timestamp"] == new_messages[0].get("timestamp"):
            m["content"] = original_user_text
            break

    # ④ text cleanup: drop base64 images and code blocks, filter out very short / symbol-only text
    cleaned = [
        {**m, "content": sanitize(m["content"])}
        for m in extracted
        if len(sanitize(m["content"]).strip()) > 5
    ]

    if not cleaned:
        return

    # ⑤ submit
    await client.add_conversation(
        session_id=session_key,
        messages=[
            {
                "role": m["role"],
                "content": m["content"],
                "timestamp": datetime.fromtimestamp(m["timestamp"] / 1000).isoformat(),
            }
            for m in cleaned
        ],
    )
```

### Why replace the "polluted user message"

Recall prepends a `<relevant-memories>...</relevant-memories>` block to the user message. If that isn't restored to the original text before writing L0, the next recall searches/embeds based on the polluted text, creating a **feedback loop** that makes memory messier and messier.

### Why slice by position

At the end of an agent turn the framework gives you the **full history**, not just this turn's additions. Sending all of it writes duplicates. Note the message count N during recall; at the end, `messages[N:]` is what's new.

---

## 3. Exposing tools

Memory injected through the prompt alone is limited. Register three more tools so the LLM can look things up itself:

| Tool | When to use | Implementation |
|---|---|---|
| `wamf_memory_search` | find structured preferences/facts | `client.search_atomic(query=..., limit=...)` |
| `wamf_conversation_search` | find original conversation snippets | `client.search_conversation(query=..., limit=...)` |
| `wamf_read_file` | read the full persona / a scene block | `client.read_file(path)` |

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

1. **Recall** uses `asyncio.gather(..., return_exceptions=True)`, so one failing branch doesn't affect the others.
2. **Capture** is wrapped in try/except; failures are only logged:
   ```python
   try:
       await capture(...)
   except Exception as e:
       logger.warning(f"capture failed: {e}")
   ```
3. **Tools** return an error string instead of raising, so the LLM sees "memory unavailable" and keeps chatting.

---

## 5. Error handling

A non-zero code raises `WAMFError`:

```python
from weaverai_memory_fabric import WAMFError

try:
    content = await client.read_file("scene_blocks/x.md")
except WAMFError as e:
    if e.code == 404:
        pass  # the file doesn't exist; normal
    else:
        logger.warning(f"memory error code={e.code} request_id={e.request_id}")
```

The server logs the `request_id` too; give it to the backend team when debugging.

---

## 6. Performance tips

- **Total recall budget < 200ms**: run the three branches in parallel, use what's available fastest, drop what times out.
- **Keep the prompt injection small**: L1 ≤ 5 items, list scene paths only (not their content), one persona. Let the LLM use the tools when it needs more detail.
- **Session granularity**: `session_key` is the L0 partition key; use a stable id for long conversations (user id + conversation id), not a new one every turn.
- **Don't call synchronously on the main thread**: use `AsyncMemoryClient`, not `MemoryClient`, or you'll block the event loop.

---

## 7. Management plane: Knowledge / metadata

Everything above is `MemoryClient` (the data plane: reading and writing memory). If you also need to **manage** the metadata of Knowledge sources (wiki / code-graph), use `MetadataClient` (the v3 management plane, which doesn't need the isolation quadruple):

```python
from weaverai_memory_fabric.v3 import MetadataClient

meta = MetadataClient(
    endpoint="http://127.0.0.1:8420",
    api_key="verify-token",
    service_id="your-instance-id",
)

# register / list / rename / delete Knowledge entities (management-plane CRUD, see README.md)
meta.create_knowledge({
    "knowledge_id": "wiki-1", "type": "wiki",
    "service_url": "http://ks:8421/v3", "name": "Wiki", "team_id": "team-1",
})
meta.list_knowledge({"team_id": "team-1", "type": "wiki"})
```

Note: `MetadataClient` only does metadata CRUD. Actually searching wiki content, reading pages and syncing repositories goes through the Knowledge Service data plane (the `:8421` that `service_url` points at), which is a separate set of endpoints outside this SDK.

---

## Appendix: reference sanitize implementation

The cleanup functions handle these kinds of noise:

```python
import re
import time

_IMAGE_DATA_URI = re.compile(r"data:image/[a-z+]+;base64,[A-Za-z0-9+/=]+", re.IGNORECASE)
_CODE_BLOCK = re.compile(r"```[\s\S]*?```")

def sanitize(text: str) -> str:
    # drop base64 images
    text = _IMAGE_DATA_URI.sub("[image]", text)
    # drop code blocks (common in assistant output, noise for embeddings)
    text = _CODE_BLOCK.sub("[code]", text)
    return text.strip()


def extract_user_assistant(messages: list) -> list:
    """Extract user/assistant text from the raw message list, dropping tool / system / empty content."""
    out = []
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            # multimodal message: join the text parts
            content = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({
            "role": role,
            "content": content.strip(),
            "timestamp": m.get("timestamp", int(time.time() * 1000)),
        })
    return out
```
