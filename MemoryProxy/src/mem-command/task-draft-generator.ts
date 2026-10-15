/**
 * task-draft-generator - LLM draft generator for mem:create-task / mem:update-task.
 *
 * The first module in the proxy that "actively" issues requests to an LLM (all other LLM calls are passthrough reverse proxying).
 * The skeleton imitates packages/cost-guard/src/compressor/cfq/llm-infer.ts - fetching OpenAI
 * chat/completions directly + AbortSignal.timeout, with no third-party SDK.
 *
 * Key differences from CFQ LLMInfer:
 * - CFQ failure = returns a null array (silent fallback), because CFQ is an optional enhancement;
 * - failure of this module = returns { ok: false, error } (**explicit error**), because a Task is a persisted entity,
 *   and a bad draft would pollute the store; the upper-layer command splices the error into the "Task generation failed: ..." message.
 *
 * Used by: mem-command/commands/create-task.ts / update-task.ts (phase 3.2 / 3.3)
 *
 * Reference: docs/design/... TODO(phase 5) add a design doc
 */

/** LLM endpoint config. Fields keep the same shape as LLMInferConfig, to ease extracting a shared one later. */
export interface TaskDraftConfig {
  /** Master switch. Default false - when not enabled the command layer directly returns a "not configured" error. */
  enabled: boolean;
  /** Model name, e.g. "deepseek-v3-0324". */
  model: string;
  /**
   * API endpoint base (excluding the concrete endpoint). Joined according to protocol:
   *   openai:    `${url}/chat/completions`
   *   anthropic: `${url}/v1/messages`
   *   responses: `${url}/responses`
   */
  url: string;
  /** API Key. openai/responses use Bearer, anthropic uses x-api-key. */
  apiKey: string;
  /** Timeout of a single call (milliseconds). Recommended 15000-30000 (the draft must be written in full). */
  timeoutMs: number;
  /**
   * Upstream API family. Default "openai" (chat/completions).
   * Determines the shape of the request URL / headers / body / response parsing in attemptDraftOnce.
   */
  protocol?: "openai" | "anthropic" | "responses";
}

/** Recent conversation message fragments (for the LLM to understand context). */
export interface DraftMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Existing Task (required in update mode). */
export interface CurrentTask {
  title: string;
  description: string;
  status: string;
}

/** Generator input. */
export interface TaskDraftInput {
  /** create: create a new task; update: decide changes based on the existing task + rewrite. */
  mode: "create" | "update";
  /** Extra hint (reason) after the user's mem:create-task/update-task, may be empty. */
  hint?: string;
  /** Recent conversation messages (the proxy cuts them from sessionMessages, usually the last 30). */
  recentMessages: DraftMessage[];
  /** Required in update mode, ignored in other modes. */
  currentTask?: CurrentTask;
  /**
   * Only effective in create mode. The user has already written the title after mem:create-task, and the proxy forcibly locks it:
   * the LLM is only responsible for generating the description from the conversation, and the title field it returns is ignored.
   * The upper-layer caller must pass lockedTitle down itself (the generator does no 40-char truncation; the caller guarantees it).
   */
  lockedTitle?: string;
}

/** Generator output: on success carries the structured draft; on failure carries an error message. */
export type TaskDraftResult =
  | {
      ok: true;
      title: string;
      description: string;
      /** Suggested status, which the model may provide (optional). */
      suggestedStatus?: string;
      /**
       * Only valid in update mode. false means "the recent conversation produced no new progress, the Task needs no update" - the upper layer
       * should directly return "Task needs no update" to the user and skip the popup flow. Always true in create mode.
       */
      changed: boolean;
    }
  | { ok: false; error: string };

/**
 * Status validation (relaxed version):
 *   Per the TAPD requirement & user decision, the proxy does no status enum validation and passes through whatever the LLM produces;
 *   only trim + empty/non-string filtering, and the kernel finally decides whether to accept it.
 */
const MAX_STATUS_LEN = 40;
/** Output schema limits. */
const MAX_TITLE_LEN = 40;
const MAX_DESC_LEN = 300;
/** Recent conversation truncation (prevents an overly long prompt). */
const MAX_RECENT_MSGS = 30;
const MAX_MSG_CONTENT_LEN = 800;
/**
 * Token cap of a single LLM generation.
 *
 * Raised from 800 to 2000 (fix on 2026-08-18): it was observed that the total of desc + title + status + JSON
 * structural characters in mixed-script scenarios often exceeds 800 and gets truncated, so the JSON ends midway and parsing fails.
 * Reference: wiki-ingest uses 8192, L1 extractor uses 4096; the draft output here is limited to title<=40
 * + desc<=300 + status, theoretical max ~800 chars -> a 2000-token cap leaves ample headroom.
 */
const LLM_MAX_TOKENS = 2000;

/**
 * LLM call retry policy (added 2026-08-18).
 *
 * Trigger scenario: occasional LLM jitter (empty object / truncation / timeout); a single call's success rate is below 100%,
 * but the probability that 2 consecutive calls both return an empty object/truncation is low. From the user's view: imperceptible, one click = one success.
 *
 * Parameters:
 *   - LLM_RETRY_MAX_ATTEMPTS=3: 3 chances in total (1 first try + 2 retries)
 *   - LLM_RETRY_BASE_DELAY_MS=200: exponential backoff base; the 2nd try waits 200ms, the 3rd waits 400ms
 *
 * When to retry: whenever attemptDraftOnce returns ok=false (no distinction by error type,
 * since empty object / truncation / schema violation / upstream 5xx are all cases where "trying again might work").
 * When not to retry: cfg.enabled=false / parameter validation fails / all 3 attempts failed.
 */
const LLM_RETRY_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 200;

/**
 * Timeout cap of the first attempt (2026-08-20): production observed the gateway occasionally hanging for 20-30s,
 * and using cfg.timeoutMs (default 30s) on the first try would leave the user waiting. The first try now uses min(cfg.timeoutMs,
 * FIRST_TIMEOUT_MS=10s); after a timeout it immediately backs off 200ms + retries, and the retry uses the full timeoutMs
 * as a fallback for the "truly slow but will succeed" scenario. Can be overridden by env WAMF_TASK_DRAFT_FIRST_TIMEOUT_MS.
 */
const LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT = 10_000;

function firstAttemptTimeoutMs(configuredTimeoutMs: number): number {
  const raw = process.env.WAMF_TASK_DRAFT_FIRST_TIMEOUT_MS;
  let cap = LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  // Must not exceed the configuration itself (otherwise the change has no effect)
  return Math.min(configuredTimeoutMs, cap);
}

/**
 * Smart URL join for taskDraft requests - handles the pitfall where "the tail of base may already carry an endpoint prefix segment".
 *
 * ## Background (2026-09-01 fix for Claude Code 404)
 *
 * Convention of the main path (guard-adapter.joinUrl): the `/v1`, `/v2`
 * tails in `upstream.agents[x].url` are part of the base, and the endpoint only writes the trailing path segment (e.g. anthropic uses `/messages`).
 * For example in the config:
 *   claude-code.url = "https://api.weaverai.example.com/v1"   (base carries a /v1 tail)
 *   codebuddy.url   = "https://api.weaverai.example.com/v2"   (base carries a /v2 tail)
 *   codex.url       = "https://api.weaverai.example.com"      (base is the root, no prefix)
 *
 * But to be self-contained, the taskDraft generator writes endpoints as "full paths":
 *   anthropic  → "/v1/messages"
 *   openai     -> "/chat/completions" (unambiguous to begin with)
 *   responses  → "/responses"
 *
 * Directly using `${base}${endpoint}` would fall into the trap:
 *   base=".../v1" + endpoint="/v1/messages" → ".../v1/v1/messages" ❌ 404
 *
 * ## Join rules
 *
 * 1. base already ends with the whole endpoint -> return as is (idempotent; handles the case where base is already a full URL)
 * 2. base already ends with **the leading segment** of the endpoint (e.g. base=`.../v1`, endpoint=`/v1/messages`)
 *    -> strip the prefix base already has and join only the rest (`.../v1/messages`)
 * 3. base and endpoint do not overlap -> join directly (`.../responses`)
 *
 * Reference: how the main path joinUrl handles this (guard-adapter.ts:326).
 */
export function joinTaskDraftUrl(base: string, endpoint: string): string {
  const normalized = base.replace(/\/+$/, "");
  // Rule 1: exactly equal
  if (normalized.endsWith(endpoint)) return normalized;
  // Rule 2: the endpoint can be split into segments (e.g. "/v1/messages" -> ["v1", "messages"]), from longest to shortest
  // check whether base already carries the leading segment of the endpoint. Strip it on a hit.
  const segs = endpoint.split("/").filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (normalized.endsWith(prefix)) {
      return normalized + "/" + segs.slice(i).join("/");
    }
  }
  // Rule 3: no overlap, join directly
  return normalized + endpoint;
}

/**
 * Instruction keyword stripping table: the LLM sometimes copies the user's raw instruction literally into the title (e.g.
 * "Fix mem:create-task LLM ..."); such prefixes are both redundant and consume the character budget.
 * Cut them on match so that the real semantic part fits within 40 characters.
 */
const COMMAND_KEYWORD_PATTERNS = [
  /^\s*(?:mem:[a-z-]+)\s*[:,]?\s*/i,
  /^\s*(?:fix|refactor|update|create|add|remove)\s+mem:[a-z-]+\s*[:,]?\s*/i,
];

/**
 * create mode system prompt.
 *
 * Strengthened 2026-08-18 (targeting the root cause of production failures):
 *   - use hard-constraint words like STRICT / MUST NOT / NEVER, replacing the earlier <= 40 (the LLM would overshoot)
 *   - add correct examples + counter-examples, so the LLM clearly knows "what is too long" and "what is an empty object"
 *   - explicitly forbid empty objects: even if information is insufficient, give a reasonable default, avoiding `{}`
 */
const SYSTEM_PROMPT_CREATE = `You are a task drafting assistant for a coding agent's memory system.

Given the recent conversation, generate ONE task that captures what the user is currently working on.

STRICT rules (violations will be rejected):
- title: MUST be 1 to 40 characters. NEVER exceed 40. Imperative form preferred.
- description: MUST be 1 to 300 characters, plain text. Cover three parts in order:
    background → goal → known constraints
- suggestedStatus: short lowercase word (e.g. "running", "completed").
- NEVER return an empty object {}. If the conversation is unclear, infer a reasonable
  task from the most recent user message and produce a best-effort title + description.

Examples of GOOD output:
  {"title":"Refactor auth module","description":"Background: auth logic is spread across 3 files. Goal: merge it into auth-service. Constraint: no change to the public API.","suggestedStatus":"running"}

Examples of BAD output (DO NOT produce these):
  {}                                                     // ❌ empty object
  {"title":"Fix mem:create-task LLM JSON parse failure and add retry logic here"}  // ❌ title too long
  {"title":"Refactor","description":""}                  // ❌ empty description

Return ONLY the JSON object with keys: title, description, suggestedStatus. No prose, no markdown fence.`;

/** create mode (title already locked) system prompt - only asks the LLM to produce the description. */
const SYSTEM_PROMPT_CREATE_LOCKED_TITLE = `You are a task drafting assistant for a coding agent's memory system.

The user has ALREADY specified the task title. Your ONLY job is to write a good description
based on the recent conversation that matches this title.

STRICT rules:
- description: MUST be 1 to 300 characters, plain text. Cover three parts:
    background → goal → known constraints
- NEVER return an empty object {}. If unclear, infer a best-effort description from the title
  and most recent messages.
- Do NOT include title in the output (it is fixed by the user).

Return ONLY a JSON object with a single key: description. No prose, no markdown fence.`;

/** update mode system prompt. */
const SYSTEM_PROMPT_UPDATE = `You are a task update assistant for a coding agent's memory system.

Given an existing task and recent conversation, decide:
1. Whether the conversation adds meaningful updates to the task.
2. If yes, produce an updated description and a suggested status.

Classify what changed into ONE OR MORE of these five categories (only if applicable):
  - goal changes
  - constraint changes
  - progress
  - linked resources / references
  - collaborating agents

STRICT rules:
- If NO meaningful update → return {"changed": false}
- If YES → return {"changed": true, "title": ..., "description": ..., "suggestedStatus": ...}
- title: keep the original title unchanged (return it as-is); the caller ignores any change.
- description: MUST be 1 to 300 characters, rewrite/merge current description with categorized new info.
- suggestedStatus: short lowercase word; prefer "completed" if conversation signals done, else "running".
- NEVER return an empty object {}. If truly no update, return {"changed": false} explicitly.

Return ONLY a JSON object. No prose, no markdown fence.`;

/**
 * Build the user message sent to the LLM.
 */
function buildUserMessage(input: TaskDraftInput): string {
  const lines: string[] = [];

  if (input.mode === "update" && input.currentTask) {
    lines.push(
      "=== Current Task ===",
      `Title: ${input.currentTask.title}`,
      `Description: ${input.currentTask.description}`,
      `Status: ${input.currentTask.status}`,
      "",
    );
  }

  if (input.mode === "create" && input.lockedTitle) {
    lines.push(
      "=== Task Title (fixed by user, DO NOT change) ===",
      input.lockedTitle,
      "",
    );
  }

  if (input.hint && input.hint.trim().length > 0) {
    lines.push("=== User Hint ===", input.hint.trim(), "");
  }

  lines.push("=== Recent Conversation ===");
  const msgs = input.recentMessages.slice(-MAX_RECENT_MSGS);
  for (const m of msgs) {
    const content = m.content.length > MAX_MSG_CONTENT_LEN
      ? `${m.content.slice(0, MAX_MSG_CONTENT_LEN)}...[truncated]`
      : m.content;
    lines.push(`[${m.role}] ${content}`);
  }

  return lines.join("\n");
}

/**
 * Extract the JSON object from the raw LLM output.
 *
 * Three-level degradation:
 *   1) Direct JSON.parse - covers the standard scenario
 *   2) Strip the markdown fence (```json ... ``` or ``` ... ```) and parse again
 *   3) Bracket-balanced scan: find the first `{`, pair forward to the matching `}`, cut that substring and parse again
 *      - covers scenarios where the LLM added natural language before/after, such as:
 *      "Sure, here is the JSON: {...}", "Here you go:\n{...}\nHope this helps"
 *
 * The scan correctly handles `{` `}` `"` inside string literals (they do not take part in balance counting).
 *
 * If all three levels fail, return null (the caller produces the "LLM output is not valid JSON" error).
 */
export function extractJsonObject(raw: string): unknown | null {
  // 1) Direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // fall-through
  }

  // 2) Strip the markdown fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall-through
    }
  }

  // 3) Bracket-balanced scan
  const balanced = findBalancedJsonObject(raw);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall-through
    }
  }

  return null;
}

/**
 * Bracket-balanced scan: find the first self-consistently closed `{...}` substring in raw.
 * The state machine handles string literals and escapes, preventing `{}` inside strings from interfering with counting.
 */
function findBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize a string field: trim + length validation.
 *
 * mode:
 *   - "strict" (default): return null when too long (old behavior, for scenarios that must be strict)
 *   - "clip": automatically cut to maxLen when too long (keeps valid content, for fields like title/description
 *     where "imperfect is still better than failing")
 *
 * An empty string always returns null (no truncation can rescue an empty string).
 */
function normalizeStr(
  v: unknown,
  maxLen: number,
  mode: "strict" | "clip" = "strict",
): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) {
    return mode === "clip" ? s.slice(0, maxLen).trim() : null;
  }
  return s;
}

/**
 * Strip instruction keyword prefixes such as mem:xxx from the title.
 * The LLM often writes the user's current instruction into the title (e.g. "Fix mem:create-task JSON parse");
 * after stripping, the real semantic part does not exceed the length limit.
 * Only prefixes are stripped, not the middle; return as is when there is no match.
 */
function stripCommandKeywords(s: string): string {
  let out = s;
  for (const pat of COMMAND_KEYWORD_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

/** Normalize the status field: optional, may be missing; no enum validation, only basic cleanup. */
function normalizeStatus(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_STATUS_LEN) return undefined;
  return s;
}

/**
 * Generate a Task draft (with automatic retry).
 *
 * Outer-layer responsibilities:
 *   - pre-validate parameters (no retry)
 *   - loop calling attemptDraftOnce, at most LLM_RETRY_MAX_ATTEMPTS times
 *   - log each failure (attempt=N/M reason=xxx), then retry after exponential backoff
 *
 * @returns { ok:true, ... } or { ok:false, error }
 */
export async function generateTaskDraft(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
): Promise<TaskDraftResult> {
  if (!cfg.enabled) {
    return { ok: false, error: "task_draft LLM disabled (config.memCommand.taskDraft.enabled=false)" };
  }
  if (input.mode === "update" && !input.currentTask) {
    return { ok: false, error: "update mode requires currentTask" };
  }
  if (!input.recentMessages || input.recentMessages.length === 0) {
    return { ok: false, error: "no recent messages to draft from" };
  }

  // Entry observation: every generateTaskDraft logs the target upstream/model/protocol, to ease aligning with handler arguments
  console.log(
    `[task-draft] START mode=${input.mode} protocol=${cfg.protocol ?? "openai"} url=${cfg.url} model=${cfg.model} msgs=${input.recentMessages.length}${input.lockedTitle ? ` lockedTitle="${input.lockedTitle}"` : ""}`,
  );

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      // Success log (printed every time, to see the jitter rate and actual attempt consumption)
      // When attempt>1, additionally carry the RETRY_SUCCEEDED keyword, to ease log aggregation of how often "jitter eventually self-healed".
      const titlePreview = "title" in result && result.title
        ? result.title.length > 40 ? `${result.title.slice(0, 40)}...` : result.title
        : "(no-title)";
      const retryTag = attempt > 1 ? " RETRY_SUCCEEDED" : "";
      console.log(
        `[task-draft] OK${retryTag} mode=${input.mode} attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} title="${titlePreview}"${attempt > 1 ? ` prev_error=${JSON.stringify(lastError)}` : ""}`,
      );
      return result;
    }
    lastError = result.error;
    // Last failure, no more waiting
    if (attempt < LLM_RETRY_MAX_ATTEMPTS) {
      const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[task-draft] mode=${input.mode} RETRY attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} error=${JSON.stringify(result.error)} next_delay_ms=${delay}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(
    `[task-draft] mode=${input.mode} ALL_ATTEMPTS_FAILED total=${LLM_RETRY_MAX_ATTEMPTS} last_error=${JSON.stringify(lastError)}`,
  );
  return { ok: false, error: `LLM draft failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts: ${lastError}` };
}

/**
 * A single LLM call + result parsing. **Internal function; the outer layer should not call it directly**.
 *
 * Same main logic as the old generateTaskDraft, except:
 *   - parameter validation moved to the outer layer
 *   - added finish_reason / usage / http_status observation logs (also printed on first-time success, to see the jitter rate)
 *
 * The attempt parameter is only used for logging.
 */
async function attemptDraftOnce(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<TaskDraftResult> {
  let resp: Response;
  // First attempt uses a short timeout (default 10s); later ones use the full cfg.timeoutMs
  const effectiveTimeoutMs = attempt === 1 ? firstAttemptTimeoutMs(cfg.timeoutMs) : cfg.timeoutMs;
  const protocol = cfg.protocol ?? "openai";
  // Record the full joined URL for observation logs (to locate path-joining mistakes such as /v1/v1/messages)
  let fetchUrl = cfg.url;
  try {
    if (protocol === "anthropic") {
      // Anthropic Messages API: /v1/messages, system goes in the top-level field, x-api-key + anthropic-version
      // Joined with joinTaskDraftUrl: base may already carry a /v1 tail (main-path convention), avoiding /v1/v1/messages
      // WARNING: the copilot upstream **forces SSE streaming** for /v1/messages (a non-streaming request returns 200 + an event-stream body,
      // which makes JSON.parse blow up with "Unexpected token 'e', event: mes..."). So stream:true is set explicitly
      // and parseAnthropicStream accumulates content_block_delta. Same strategy as the openai branch.
      fetchUrl = joinTaskDraftUrl(cfg.url, "/v1/messages");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else if (protocol === "responses") {
      // OpenAI Responses API: /responses, instructions go in the top-level field, input[] is structured,
      // and the token cap field is named max_output_tokens. Bearer auth.
      // The upstream codex base is the root (no /v1/v2 prefix), so rule 3 of joinTaskDraftUrl takes the "join directly" branch.
      // WARNING: the copilot upstream likewise **forces SSE streaming** for /responses (a non-streaming request gets 200 + an event-stream
      // body back, and the client parsing it as JSON blows up with "Unexpected token 'e', event: res..."). So
      // stream:true is set explicitly and parseResponsesStream accumulates response.output_text.delta.
      // Same strategy as the anthropic/openai branches - copilot forces streaming on all three protocols.
      fetchUrl = joinTaskDraftUrl(cfg.url, "/responses");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          instructions: systemPrompt,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: userMessage }] },
          ],
          temperature: 0.3,
          max_output_tokens: LLM_MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } else {
      // OpenAI chat/completions (default).
      // WARNING: the copilot upstream requires stream:true (non-streaming returns 400 "Non-stream chat request
      // is currently not supported"). So response_format is dropped (some upstreams don't recognize it when streaming),
      // and JSON relies on prompt constraints + the three-level extractJsonObject fallback. stream_options.include_usage
      // makes upstream send an extra usage chunk at the end for observation.
      // base usually carries a /v2 tail (main-path convention), and rule 3 of joinTaskDraftUrl takes the "join directly" branch
      // giving .../v2/chat/completions (the endpoint does not overlap with base).
      fetchUrl = joinTaskDraftUrl(cfg.url, "/chat/completions");
      resp = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: LLM_MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=fetch_error protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} error=${JSON.stringify(msg)}`,
    );
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  // Log the HTTP status of every upstream response (both success and failure, to locate path-joining mistakes / 401 / upstream 502, etc.)
  console.log(
    `[task-draft] mode=${input.mode} attempt=${attempt} HTTP status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model}`,
  );

  if (!resp.ok) {
    let errBodyPreview = "";
    try {
      const errText = await resp.text();
      errBodyPreview = errText.length > 500 ? `${errText.slice(0, 500)}...[truncated]` : errText;
    } catch {
      errBodyPreview = "[read body failed]";
    }
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status} protocol=${protocol} url=${cfg.url} fullUrl=${fetchUrl} model=${cfg.model} body=${JSON.stringify(errBodyPreview)}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let finishReason = "unknown";
  let completionTokens = -1;
  let content: string | undefined;

  if (protocol === "openai") {
    // Streaming: read the SSE text, accumulate delta.content + the final finish_reason / usage
    const sse = await parseOpenAiStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else if (protocol === "anthropic") {
    // The Anthropic upstream likewise only supports SSE (copilot especially). Read the event stream, accumulate
    // content_block_delta.delta.text_delta.text; stop_reason / output_tokens come from
    // the usage field of the message_delta event.
    const sse = await parseAnthropicStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  } else {
    // responses: the copilot upstream likewise forces SSE. Accumulate the delta of response.output_text.delta events;
    // status / usage.output_tokens come from the response.completed event.
    const sse = await parseResponsesStream(resp);
    if (sse === null) {
      return { ok: false, error: "LLM stream response unreadable" };
    }
    content = sse.content;
    finishReason = sse.finishReason;
    completionTokens = sse.completionTokens;
  }

  // When content is empty, all three protocol branches have already returned early, so by here content is definitely non-empty
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  // Common observation fields (every FAIL log carries these, so the root cause is visible at a glance)
  const obs = `attempt=${attempt} protocol=${protocol} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

  // Three-level fallback: direct parse -> markdown fence -> bracket-balanced scan
  const parsed = extractJsonObject(content);
  if (parsed === null) {
    // Key troubleshooting log: print the first 500 chars of the raw LLM content, to locate which failure mode it is
    // (standard scenario / markdown fence / natural language before/after / no JSON at all)
    // finish_reason=length means max_tokens truncation, and the cap needs to be raised
    console.log(
      `[task-draft] mode=${input.mode} FAIL=json_parse ${obs} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not valid JSON" };
  }
  if (typeof parsed !== "object") {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=not_object ${obs} parsed_type=${typeof parsed} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // update mode: look at the changed field first
  if (input.mode === "update" && obj.changed === false) {
    // Return the currentTask values as is; with changed=false the upper layer skips the popup directly
    return {
      ok: true,
      changed: false,
      title: input.currentTask!.title,
      description: input.currentTask!.description,
      suggestedStatus: input.currentTask!.status,
    };
  }

  // create mode + lockedTitle: title is forced to lockedTitle, only the description is parsed
  //
  // Lenient policy (2026-08-18): description fails only when **entirely missing/empty string/not a string**;
  // if too long it is auto-truncated to MAX_DESC_LEN - the LLM writing a few fewer characters is far better than returning an error to the user.
  if (input.mode === "create" && input.lockedTitle) {
    const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
    if (!description) {
      console.log(
        `[task-draft] mode=create-locked FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
      );
      return { ok: false, error: `description missing or empty` };
    }
    const suggestedStatus = normalizeStatus(obj.suggestedStatus);
    return {
      ok: true,
      changed: true,
      title: input.lockedTitle,
      description,
      ...(suggestedStatus ? { suggestedStatus } : {}),
    };
  }

  // title normalization: first strip instruction keyword prefixes, then use clip mode.
  //   Typical scenario: "Fix mem:create-task JSON parse failure" (42 chars, would be rejected for exceeding 40)
  //   -> strip "Fix mem:create-task " -> "JSON parse failure" (more concise and within the limit)
  const rawTitle = typeof obj.title === "string" ? stripCommandKeywords(obj.title) : obj.title;
  const title = normalizeStr(rawTitle, MAX_TITLE_LEN, "clip");
  if (!title) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=title ${obs} keys=${JSON.stringify(Object.keys(obj))} title_type=${typeof obj.title} title_len=${typeof obj.title === "string" ? obj.title.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `title missing or empty` };
  }
  const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
  if (!description) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `description missing or empty` };
  }
  const suggestedStatus = normalizeStatus(obj.suggestedStatus);

  return {
    ok: true,
    changed: true,
    title,
    description,
    ...(suggestedStatus ? { suggestedStatus } : {}),
  };
}

/**
 * Log helper: truncate long strings, preventing LLM floods from blowing up the logs.
 * 500 chars is enough to see the JSON structure and main content; the rest is marked with `...[truncated N]`.
 */
function previewContent(s: string): string {
  const MAX = 500;
  return s.length > MAX ? `${s.slice(0, MAX)}...[truncated ${s.length - MAX}]` : s;
}

/**
 * Log helper: serialize the parsed obj into a compact string and then truncate (keeping the structure).
 * Used in failure branches - so that when troubleshooting you can see at a glance what fields and values the LLM filled in.
 */
function previewObj(obj: Record<string, unknown>): string {
  try {
    return previewContent(JSON.stringify(obj));
  } catch {
    return "[unserializable]";
  }
}

/**
 * Parse the SSE streaming response of OpenAI chat/completions.
 *
 * The copilot upstream only supports stream:true and returns `text/event-stream`, with each line shaped like
 * `data: {...}` and ending with `data: [DONE]`. Here all `choices[].delta.content`
 * fragments are accumulated into the full body, recording the last non-empty finish_reason, as well as
 * the completion_tokens of the trailing usage chunk when stream_options.include_usage=true.
 *
 * Returning null means the stream read failed (body unreadable / no valid content).
 */
async function parseOpenAiStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / partial packets etc., ignored
    }

    const choices = evt.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      if (first.finish_reason && typeof first.finish_reason === "string") {
        finishReason = first.finish_reason;
      }
      const delta = first.delta as Record<string, unknown> | undefined;
      const deltaContent = delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        parts.push(deltaContent);
      }
    }

    const usage = evt.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.completion_tokens === "number") {
      completionTokens = usage.completion_tokens;
    }
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * Parse the SSE streaming response of the Anthropic Messages API.
 *
 * The copilot upstream forces SSE (`text/event-stream`) for /v1/messages, with the format:
 *   event: message_start
 *   data: {"type":"message_start", "message":{...,"usage":{"input_tokens":N,"output_tokens":M}}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * Extracted:
 *   - content = all content_block_delta.delta.text_delta.text concatenated in order
 *   - finishReason = message_delta.delta.stop_reason (unknown if absent)
 *   - completionTokens = message_delta.usage.output_tokens
 *     (also picks up output_tokens if upstream puts it in message_start.message.usage; the last one overwrites)
 *
 * Consistent with parseOpenAiStream: ignore `event:` lines, ignore keep-alive/partial JSON,
 * ignore deltas that are not text_delta (e.g. input_json_delta is used for tool_use, not needed in this scenario).
 *
 * Returning null means: body unreadable / content is empty after accumulating to the end (no text_delta).
 */
async function parseAnthropicStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Only care about `data:` lines; `event:` lines only separate events and carry no payload
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue; // keep-alive / partial packets etc., ignored
    }

    const evtType = evt.type;

    // 1) content_block_delta: accumulate text
    if (evtType === "content_block_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        parts.push(delta.text);
      }
      continue;
    }

    // 2) message_delta: get stop_reason + output_tokens
    if (evtType === "message_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        finishReason = delta.stop_reason;
      }
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        completionTokens = usage.output_tokens;
      }
      continue;
    }

    // 3) message_start: some upstreams put output_tokens here (may be 0/1, pick it up first as a fallback)
    if (evtType === "message_start") {
      const message = evt.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number" && completionTokens < 0) {
        completionTokens = usage.output_tokens;
      }
      continue;
    }
    // Other events (content_block_start / content_block_stop / message_stop / ping) need no handling
  }

  const content = parts.join("");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}

/**
 * Parse the SSE streaming response of the OpenAI Responses API.
 *
 * The copilot upstream forces SSE (`text/event-stream`) for /responses. Event stream format (
 * see https://platform.openai.com/docs/api-reference/responses-streaming):
 *
 *   event: response.created
 *   data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress",...}}
 *
 *   event: response.output_item.added
 *   data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message",...}}
 *
 *   event: response.content_part.added
 *   data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text",...}}
 *
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"..."}
 *
 *   event: response.output_text.done
 data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"full text"}
 *
 *   event: response.completed
 *   data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":42},...}}
 *
 * Extracted:
 *   - content = all response.output_text.delta.delta concatenated in order
 *     (fallback: if there are no delta events but there is response.output_text.done, use done.text directly)
 *   - finishReason = response.completed.response.status ("completed" / "incomplete", etc.)
 *   - completionTokens = response.completed.response.usage.output_tokens
 *
 * Ignore event: separator lines / partial JSON / other unrecognized events (such as response.in_progress,
 * response.output_item.done, response.reasoning_summary_*, etc.).
 *
 * Returning null means: body unreadable / content is empty after accumulating to the end.
 */
async function parseResponsesStream(resp: Response): Promise<{
  content: string;
  finishReason: string;
  completionTokens: number;
} | null> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return null;
  }

  const parts: string[] = [];
  // Fallback: if upstream sends no delta and only sends output_text.done once (rare but allowed by the spec),
  // keep the last done.text as the fallback.
  let doneText: string | null = null;
  let finishReason = "unknown";
  let completionTokens = -1;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const evtType = evt.type;

    // 1) response.output_text.delta: the main path, accumulate incremental text
    if (evtType === "response.output_text.delta") {
      const delta = evt.delta;
      if (typeof delta === "string" && delta.length > 0) {
        parts.push(delta);
      }
      continue;
    }

    // 2) response.output_text.done: fallback, get the full text (used as a fallback when there is no delta)
    if (evtType === "response.output_text.done") {
      const t = evt.text;
      if (typeof t === "string" && t.length > 0) {
        doneText = t;
      }
      continue;
    }

    // 3) response.completed: get the final status / usage
    if (evtType === "response.completed") {
      const response = evt.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.status === "string") {
          finishReason = response.status;
        }
        const usage = response.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          completionTokens = usage.output_tokens;
        }
      }
      continue;
    }
    // Other events (response.created / response.in_progress / response.output_item.* /
    // response.content_part.* / response.reasoning_summary_* / ping, etc.) need no handling
  }

  // Prefer the delta-concatenated result; fall back to done.text only when there is no delta at all
  const content = parts.length > 0 ? parts.join("") : (doneText ?? "");
  if (content.length === 0) return null;
  return { content, finishReason, completionTokens };
}
