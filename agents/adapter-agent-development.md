# New client adapter guide

> **What this is for**: if you want to connect a new AI Agent client that Memory Proxy **doesn't support yet** (Aider / Cursor / a new desktop IDE / your own CLI / some future harness), follow this guide from "capture and inspect traffic → list the adaptation scope → 20 code steps → e2e passing". It is based on 5 clients already done (Claude Code / CodeBuddy / Codex / Workbuddy / dsh) and records the general pitfalls and adaptation points from each one, so the next client doesn't have to hit them all again.
>
> **Don't skip steps**: every step was extracted from a real pitfall. When you hit a problem, check [§3 common pitfalls](#stage-3-common-pitfalls) first.
>
> **Reference implementation**: dsh is the most thoroughly worked-through integration so far, and all its code is in this repository. See [Reference implementation: dsh (grouped by capability)](#reference-implementation-dsh-grouped-by-capability) at the end, which lists **for each adaptation item** where dsh made the change, so you can copy it for your own client.

---

## Stage 0: capture and inspect traffic (30–60 minutes, no code changes)

**Why capture first**: assuming clients behave the same = hitting a pitfall every time. **Each** of the 5 clients differs in body shape / session_id header / metadata wrapper / maximum number of options / ask-user tool name. **Pin down these 5 differences** before touching code.

### 0.1 Capture 3–5 real requests

Use **mitmproxy**:

```bash
pip3 install --user mitmproxy    # skip if already installed
mitmdump -p 8888 -s /tmp/capture.py --set stream_large_bodies=100m
```

The addon in `/tmp/capture.py` does one thing: it greps the target client's requests by `user-agent` and saves the request and response bodies as JSON. Change the grep keyword to the new client's fingerprint.

**Important**: Node ≥18 clients need `NODE_OPTIONS='--use-env-proxy'` to honour `HTTPS_PROXY` (undici ignores it by default). See [§3 pitfall G](#pitfall-g-node-22-ignores-https_proxy-when-capturing).

### 0.2 Fill in the 5 differences from the capture

Create a `<client>-recon/` directory (outside this repository, or local only) for the fixtures and analysis, and go through this table:

| Dimension | What to look for in the capture |
|---|---|
| **body shape** | Is the main body field `messages[]` (OpenAI/Anthropic) or `input[]` (OpenAI Responses)? Is the user text in `messages[i].content[j].text`, `messages[i].content` (str) or `input[i].content[j].text`? |
| **session_id header** | Which headers are there and which one is the sid? Is there a backup field in the body? |
| **first-request metadata role=user** | Count how many role=user entries the client puts in `messages[]` and identify a stable signature for each (prefixes such as `<system-reminder>` / runtime context / available_skills). Only the one with the real user input should be treated as the "user message" by the proxy; the other metadata entries must be filtered |
| **ask-user tool name + shape** | Find the client source `packages/*/tool-ask-user/**` or similar and get the tool name + parameter schema (required fields / snake vs camel case) |
| **maximum number of options** | Search the client UI source for `options.length` / `maxOptions` / `slice`; no truncation = no pagination needed |

**These 5 differences decide the code changes that follow**. Miss one and you will hit a pitfall.

### 0.3 Decide whether you need an aux short-circuit

Check whether the client sends **separate kinds of requests** (compaction / title-gen / memgen, etc.). Signals:

- a separate endpoint path? (codex has `/responses/compact`, workbuddy is similar)
- a separate header? (dsh has `x-deepseek-harness-compact:1`)
- body features? (dsh title-gen: no tools + `thinking.disabled` + `max_tokens ≤ 128` + a system prompt prefix)

**For any client with aux requests, the adapter's `classifyRequest` must recognise them**. CC/CB send only main requests; codex/workbuddy/dsh all have aux.

---

## Stage 1: adaptation scope (decide what to do first)

Memory Proxy does **at least** the following for a client. Don't start by diffing dsh and copying code. **Tick through this table first**: which capabilities **must** work on the new client, which are **optional** and which **don't apply**. Once the list is ticked, go to stage 2 and write code; you'll know how much work it is.

| # | Capability | What it solves | Required? | Related modules |
|---|---|---|---|---|
| 1 | **Routes & allow-lists** | makes the proxy recognise `/<client>/<spaceId>/...` and adds `<client>` to the allow-list regexes; otherwise auth 401 / requests fall through to 404 | ✅ required | `MemoryProxy/src/server.ts`, `MemoryProxy/src/credit-reporter.ts` |
| 2 | **Session ID resolution** | finds a stable "unique conversation identifier" in the client's headers/body so every request in one conversation lands on the same sessionKey; miss it → all conversations collide on one key and session-init state gets mixed up | ✅ required | `MemoryProxy/src/session/session-key.ts::resolveConversationId` |
| 3 | **Request classification (main / aux / headless)** | separates "real user conversation" from "client background helper requests" (title-gen / compaction / memgen); aux must **skip all** of session-init / mem / injection / L0 / skill trigger and pass straight through | ✅ required | `MemoryProxy/src/agent-adapters/<client>.ts::classifyRequest`, top of `MemoryProxy/src/handler.ts` |
| 4 | **User text extraction** | picks the "real user input" string out of the body (for mem command detection / L0 archiving / skill extraction) and skips metadata role=user entries | ✅ required | `MemoryProxy/src/agent-adapters/<client>.ts::extractUserText`, `MemoryProxy/src/session/store.ts::tryHistoryScan`, `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` |
| 5 | **Session init form** | on the first conversation, shows a 4-step form for the user to pick team / agent / task (`asset_confirm → team → agent → task`); carried by an `ask_user_question` (or similar) tool_call from the client's preset | ⚠️ required if the client is interactive; optional for pure headless CLIs (use the bypass from pitfall C) | `MemoryProxy/src/session/<client>/form.ts`, `MemoryProxy/src/session/index.ts` dispatch, `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate |
| 6 | **Header preselection (skip the form)** | CI/CD / automation / clients that can't answer a form can send `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id` headers and register the session in one step; supported generically, most clients **need no code changes** | ➖ optional (already generic) | no changes; handled generically by `MemoryProxy/src/session/registrar.ts` |
| 7 | **Asset injection** | on every main turn, inserts asset blocks such as `<agent_skills>` / `<user_memory>` / `<session_context>` / `<wamf_profile_memory>` into the system message to bring team memory to the LLM | ✅ required | use the existing `MemoryProxy/src/injection/adapters/{openai,anthropic}.ts`; if the client's wire has special fields (e.g. dsh `reasoning_content`) add a metadata round-trip |
| 8 | **Wire compatibility / special field pass-through** | the client may strictly require some non-standard fields to round-trip (dsh's `reasoning_content` / the DeepSeek thinking chain); the injection pipeline's parse→serialize must not drop them | ⚠️ only if the client has special fields | `parseMessage` / `serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`, stored in `ContextMessage.metadata` |
| 9 | **Mem command interception** | when the user sends `mem:help` / `mem:sync` / `mem:create-skill` / `mem:session-reset`, the proxy intercepts and returns a short-circuit response (open the panel / refresh assets / trigger extraction / reset state) without calling the upstream LLM | ✅ all of them work when the client has form ability; headless-bypass clients only support some | the mem-command section in `MemoryProxy/src/handler.ts` (generic; works automatically once `agentSource` is recognised) |
| 10 | **L0 archiving / skill extraction** | messages in both directions of the main conversation go to `wamf-recorder:write-l0`; when the conversation passes a threshold or the user force-archives, `skill/conversation/add` makes core extract a skill | ✅ required | the end of `MemoryProxy/src/handler.ts` (generic; works automatically once the aux/headless signals are right) |
| 11 | **Observability / Langfuse** | traces carry an `agent_source:<client>` tag, session-init stages are logged, tool_calls are tracked, for debugging in production | ✅ required (one tag, nearly free) | injected generically via `agentAdapter.agentKind`; check the new `agent_source` shows up in the Langfuse trace tags |

**Rules for deciding**:

- every "required" row must be **done** before it counts as basically working
- "optional" rows depend on the client (a CLI-only client can skip 5 and 9 and keep only 6, header preselection)
- the client has its own wire fields (like the DeepSeek thinking chain) → capability 8 is mandatory, otherwise the upstream returns 400
- the client sends title-gen / compact or other aux requests → capability 3 is mandatory, otherwise aux requests wrongly show the form / wrongly write L0

**Effort estimate**: a full adaptation (covering 1–11), with dsh as a proven reference, takes about 3–4 working days for capture + code + unit tests + e2e; pitfalls nobody has seen before come on top.

---

## Stage 2: code changes (20-step checklist, in order)

Map the capabilities you ticked in stage 1 to concrete files. Each step names its capability number (capability #1 = "routes & allow-lists", and so on).

### 2.1 Skeleton, 4 steps (30 minutes): capabilities #1, #3, #4

| # | File | Change | Capability |
|---|---|---|---|
| 1 | `MemoryProxy/src/agent-adapters/<client>.ts` | new: `classifyRequest` with three signals + `extractUserText` | #3 #4 |
| 2 | `MemoryProxy/src/agent-adapters/types.ts` | add `"<client>"` to the `AgentKind` union | #3 |
| 3 | `MemoryProxy/src/agent-adapters/index.ts` | add a case to the factory switch | #3 |
| 4 | `MemoryProxy/src/server.ts` | add 9 routes (with/without `v1` × main endpoint/aux/cost-guard/analyse marker); copy the dsh section | #1 |

### 2.2 Allow-lists & session identification, 3 steps: capabilities #1, #2, #7

| # | File | Change | Capability |
|---|---|---|---|
| 5 | `MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | add `\|<client>` to the regex. **Miss it and you get auth 401 `missing service_id`** | #1 |
| 6 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` | add the client's session header to the header fallback chain | #2 |
| 7 | skip if no separate profile is needed; otherwise a `MemoryProxy/src/injection/agents/<client>/*` set (see `MemoryProxy/src/injection/agents/workbuddy/`) | | #7 |

### 2.3 Session init form carrier, 4 steps: capability #5

| # | File | Change | Capability |
|---|---|---|---|
| 8 | `MemoryProxy/src/session/<client>/form.ts` | new: tool name / parameter shape exactly as the client preset defines them; don't reuse another client's | #5 |
| 9 | `MemoryProxy/src/session/index.ts` | add a dispatch branch (see the workbuddy one: the CB state machine produces `formData`, the outer layer re-renders it) | #5 |
| 10 | `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate | add `\|\| agentSource === "<client>"` to the 5 gates. Miss it and agent+task get asked together and it bypasses straight away | #5 |
| 11 | `tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` | recognise the `\|<client>_` prefix | #5 |

### 2.4 Metadata filtering & wire compatibility, 3 steps: capabilities #4, #8

| # | File | Change | Capability |
|---|---|---|---|
| 12 | `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` | skip the user count for the client's first-request metadata signatures. Miss it and it wrongly decides "has history" and skips session-init | #4 |
| 13 | `MemoryProxy/src/session/store.ts::tryHistoryScan` | the same filter | #4 |
| 14 | wire special-field round-trip (e.g. dsh's `reasoning_content`): keep it via metadata in parse/serialize in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`; verify by comparing two-way body dumps with the debug env vars | | #8 |

### 2.5 Handler short-circuits, 2 steps: capabilities #3, #5, #9, #10

| # | File | Change | Capability |
|---|---|---|---|
| 15 | top of `MemoryProxy/src/handler.ts` | call `agentAdapter.classifyRequest(body, path, headers)`; when `isAuxiliary=true`, **skip all** of session-init / mem / injection / L0 / skill trigger and pass straight through | #3 #9 #10 |
| 16 | top of `MemoryProxy/src/handler.ts` | if the client has a headless CLI mode (a smaller preset with no ask-user tool), add a `_headless` signal like dsh's and skip the form as for aux; for mem commands, show a hint or fall back to header preselection | #5 #9 |

### 2.6 Tests & verification, 4 steps: capabilities #5, #9, #10, #11

| # | What | Capability |
|---|---|---|
| 17 | unit tests: adapter `classifyRequest` + form builder shape + real-capture fixtures end to end, in `MemoryProxy/src/__tests__/agent-adapters/<client>.test.ts` + `MemoryProxy/src/session/<client>/__tests__/form.test.ts` | #3 #5 |
| 18 | curl smoke: hit `/<client>/default/*` directly to trigger the form and check the session-init transitions (`asset_confirm → team → agent → task`) | #5 |
| 19 | web e2e (playwright recommended): **really run the client's web UI** (the 4 session-init steps + 1 real turn, checking injection + archiving + Langfuse trace) | #5 #7 #10 #11 |
| 20 | mem / L0 / skill end to end: in an initialised session send `mem:help` / `mem:sync` / `mem:create-skill`, let a long conversation trigger skill extraction, grep the proxy log for the L0 write | #9 #10 |

---

## Stage 3: common pitfalls

Each of the first 5 clients hit at least 3 of these. **Check here before debugging yourself**.

### Pitfall A: `missing service_id (spaceId not in request path)` 401

**Cause**: the allow-list regex in `credit-reporter.ts::extractSpaceIdFromPath` doesn't include the new client's name.

**Fix**: add it to `^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|<new-client>)$`.

### Pitfall B: the session-init form shows up wrongly / never shows up

- **Never shows up** = the `resolveConversationId` fallback doesn't recognise the client's session header → the sessionKey falls back to keyId, or `isFreshCBConversation` counts the first-request metadata user entries as "has history" → markerless bypass.
  - fix the `session-key.ts` fallback chain + `codebuddy/init.ts::isFreshCBConversation` + `store.ts::tryHistoryScan` by adding the metadata signature filter
- **Shows up, but no task question after picking the agent** = the split-stage gate doesn't include the new client → it takes CB's old combined pending_agent_task question → the task is empty and it bypasses.
  - fix by adding `|| agentSource === "<client>"` to the 5 gates in `codebuddy/init.ts`
- **Paging loops forever / the default task appears at the top of every page** = CC's 4-per-page pagination was reused without the MORE interception.
  - fix: when the client UI has no options limit, **turn off pagination and render everything** (that's what dsh does)

### Pitfall C: upstream 400 `unknown tool ""`

**Cause**: the client preset doesn't include `ask_user_question` (or this client's UI tool), so the fake `tool_call` the proxy inserts fails validation.

**Fix**: add a headless bypass: when `body.tools` is non-empty but lacks that tool, pass through without showing the form.

### Pitfall D: upstream 400 `The reasoning_content in the thinking mode must be passed back to the API`

**Cause** (two pitfalls at once):

1. the fake session-init assistant message has no `reasoning_content` field
2. it was set to an empty string `""` → the client's translate.ts drops it because it checks `length > 0`

**Fix**: put a **non-empty** placeholder in the fake response (e.g. `[proxy session-init form]`).

**Follow-up pitfall**: with a non-empty placeholder the client does replay it back to the proxy, but **the injection pipeline's parse→serialize drops the field**.

- capture the inbound/outbound bodies with the `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` env vars and compare them.
- fix `parseMessage`/`serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` / `anthropic.ts` to keep pass-through fields in `ContextMessage.metadata`.

### Pitfall E: aux requests (compaction / title) wrongly go through session-init and show the form

**Cause**: the top of `handler.ts` doesn't call `classifyRequest`, so every request is treated as main.

**Fix**: call `agentAdapter.classifyRequest(body, path, headers)` at the top of `handler.ts`; when `isAuxiliary=true`, **skip all** of session-init / mem / injection / L0 / skill trigger.

### Pitfall F: a client-specific wire field (e.g. `reasoning_content`) is lost in the round-trip

See pitfall D's follow-up. **General approach**: compare inbound/outbound fields with `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY`; if any are lost, fix the adapter.

### Pitfall G: Node 22 ignores HTTPS_PROXY when capturing

**Fix**: add `NODE_OPTIONS='--use-env-proxy'`. It's experimental in undici, but currently the only way.

### Pitfall H: capturing headless and concluding the tool doesn't exist

**Lesson**: the preset system decides the tools, and different profiles routinely include different tools. **The tools array in web / tui mode is always fuller than headless**. Capture web if you can, or capture both once.

---

## Done criteria

The adaptation is done only when **all** of these are verified (the left column is the capability number):

| Capability | Done when |
|---|---|
| #1 routes | `curl -X POST /<client>/default/chat/completions` returns neither 404 nor 401 `missing service_id` |
| #2 sessionKey | several requests with the same session_id show the same `sessionKey=` in the proxy log |
| #3 request classification | for aux requests (compaction / title-gen) the proxy log shows `[request-classify] → auxiliary (skip ...)` and they pass straight through |
| #5 session init | the first request returns the form (role=assistant + a `tool_call` named after the client preset's ask-user tool); playwright completes the 4 steps `asset_confirm → team → agent → task` |
| #7 injection | the main conversation's upstream returns 200 and the system message the upstream sees contains asset blocks such as `<agent_skills>` / `<user_memory>` |
| #8 wire compatibility | the main conversation's upstream **doesn't** return 400 (`reasoning_content` / `unknown tool` / `invalid_request_error`) |
| #9 mem commands | `mem:help` / `mem:sync` / `mem:create-skill` are intercepted and return short-circuit responses |
| #10 L0 & skill | the proxy log has `wamf-recorder:write-l0`, meaning L0 was written, and `[skill-conversation-add] archived reason=tool_calls`, meaning skill extraction was triggered |
| #11 observability | Langfuse traces carry the `agent_source:<client>` tag |
| — unit tests | `npx vitest run src/session/<client> src/__tests__/agent-adapters/<client>.test.ts` all green |
| — full test suite | `npx vitest run` with no regressions |

---

## Reference implementation: dsh (grouped by capability)

dsh is the integration that **hit the most pitfalls and is the most complete** so far. This table follows the capability numbers from [stage 1 adaptation scope](#stage-1-adaptation-scope-decide-what-to-do-first) and lists **where in the code dsh implements each capability**, so you can copy it and rename for your own client.

| Capability | dsh implementation | Notes |
|---|---|---|
| #1 routes & allow-lists | dsh section of `MemoryProxy/src/server.ts` (9 routes)<br>`MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | main `/chat/completions` × (with/without v1) × (main/aux/cost-guard/analyse marker) |
| #2 session ID resolution | `MemoryProxy/src/session/session-key.ts::resolveConversationId` (`x-deepseek-harness-session-id` fallback) | dsh only takes the sid from the header; no body fallback |
| #3 request classification | `MemoryProxy/src/agent-adapters/dsh.ts::classifyRequest`<br>aux short-circuit at the top of `MemoryProxy/src/handler.ts` | three signals: compact header > title body shape > main |
| #4 user text & metadata filtering | `MemoryProxy/src/agent-adapters/dsh.ts::extractUserText`<br>`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation`<br>`MemoryProxy/src/session/store.ts::tryHistoryScan` | dsh puts 3 metadata role=user entries in the first request; they are skipped by signature |
| #5 session init form | `MemoryProxy/src/session/dsh/form.ts` (tool = `ask_user_question`, call_id prefix `call_dsh_session_init_`)<br>dsh dispatch branch in `MemoryProxy/src/session/index.ts`<br>`agentSource === "dsh"` added to the 5 split-stage gates in `MemoryProxy/src/session/codebuddy/init.ts`<br>`dsh_` prefix added to the `tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` | reuses the CB state machine; the dsh UI has no options limit, so **no pagination** |
| #7 injection | reuses `MemoryProxy/src/injection/adapters/openai.ts` (no separate profile) | dsh is standard OpenAI Chat; the injection template is the CB one |
| #8 wire compatibility | `MemoryProxy/src/injection/adapters/openai.ts::parseMessage`/`serializeMessage` (`reasoning_content` kept in `ContextMessage.metadata`) | the DeepSeek thinking chain is strictly required to round-trip |
| #9 mem commands | the generic mem-command section works automatically; it degrades only in dsh headless mode (the `handler.ts::_dshHeadless` signal) | headless-bypass clients get a dedicated degraded hint for `mem:session-reset` |
| #10 L0 & skill | the generic end of the handler works automatically; skipped when `_dshHeadless` (the related `if !_dshHeadless` in `handler.ts`) | no dsh special-casing needed once the aux signals are right |
| #11 observability | `agentAdapter.agentKind = "dsh"` is injected generically into the Langfuse trace tags | no extra tracking code needed |
| — headless bypass (dsh only) | `MemoryProxy/src/handler.ts::_dshHeadless` (`body.tools` non-empty but without `ask_user_question` → bypass) | the dsh CLI has no preset; the whole flow skips form / mem / injection |
| — unit tests (39, the most complete fixture set) | `MemoryProxy/src/__tests__/agent-adapters/dsh.test.ts` (19 adapter tests)<br>`MemoryProxy/src/session/dsh/__tests__/form.test.ts` (17 form tests)<br>`MemoryProxy/src/injection/adapters/__tests__/openai.test.ts` (3 openai round-trip tests) | copying them and renaming the client mostly just works |

The user-facing configuration docs (baseURL / config files / session-init interaction flow) are in [`agents/dsh/README.md`](./dsh/README.md).
