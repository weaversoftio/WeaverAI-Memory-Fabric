/**
 * SkillExtractor — extraction entry that accepts structured ExtractMessage[]
 *
 * Differences from the old SkillExtractor:
 *   - the messages argument must be `ExtractMessage[]`; bare strings are no longer accepted
 *   - internally chains messages into a transcript (keeping role markers)
 *   - tool calls go through SkillToolsV2 (operating on SkillCore)
 *   - candidates are returned in ExtractedSkillCandidate form (with skill_id / version)
 *
 * Every call goes through the LLM, with no conversation-level dedup/caching - the caching mechanism has been removed.
 */

import type { ExtractMessage } from "./types.js";
import type { SkillCore } from "./skill-core.js";
import { createSkillTools, type ExtractedSkillCandidate } from "./skill-tools.js";
import type {
  ISkillExtractor,
  ConversationMessage,
  ExtractedCandidate,
} from "./queue/types.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { trace } from "../report/trace.js";
import { obsLogger } from "../report/obs-logger.js";

const TAG = "[skill-extractor]";

export interface ExtractorRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    /** Output token cap; if not set, the runner falls back (the standard runner uses llm.maxTokens). */
    maxTokens?: number;
    taskId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Langfuse trace name (for UI filtering and naming, see LLMRunParams in core/types.ts). */
    traceName?: string;
    /** Langfuse tags (for UI filtering). */
    tags?: string[];
    /** Langfuse top-level sessionId. */
    sessionId?: string;
    /** Langfuse top-level userId. */
    userId?: string;
    /** Instance id; passed through as the telemetry instanceId (when missing, the runner side falls back to "unknown"). */
    instanceId?: string;
  }): Promise<string>;
}

export interface ExtractorOptions {
  core: SkillCore;
  runner?: ExtractorRunner;
  systemPrompt?: string;
  maxIterations?: number;
  /** Transcript head-tail truncation: chars to keep from the start (default 8000). */
  headChars?: number;
  /** Transcript head-tail truncation: chars to keep from the end (default 32000). */
  tailChars?: number;
  /**
   * Output token cap of a single skill review LLM call. If not set → the runner inherits llm.maxTokens.
   * Configured independently of llm.maxTokens: skill review output (including the full SKILL.md
   * text in tool-call arguments) is usually larger than other stages and may need to be raised separately.
   */
  maxTokens?: number;
  /**
   * Cap on the pre-retrieved skill list size (shared by relevant BM25 search & the recent fallback).
   * The constructor default is 0 (off); the production wiring layer (wamf-core / server) explicitly passes
   * resolved.extraction.prefixSkillsLimit (default 20) from skill-config. Tests that construct with no arguments
   * do not trigger the extra query-gen LLM call.
   */
  prefixSkillsLimit?: number;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface ExtractInput {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  /** Instance id (= space_id); passed through as the runner telemetry's instanceId. */
  space_id?: string;
  messages: ExtractMessage[];
  options?: {
    max_iterations?: number;
  };
  /** The main Agent's extraction hint; when set, injected at the very front of the extraction LLM's user prompt. */
  reason?: string;
}

export interface ExtractResult {
  candidates: ExtractedSkillCandidate[];
  text?: string;
}

export class SkillExtractor {
  private readonly core: SkillCore;
  private readonly runner?: ExtractorRunner;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly maxTokens?: number;
  private readonly prefixSkillsLimit: number;
  private readonly logger?: ExtractorOptions["logger"];

  constructor(opts: ExtractorOptions) {
    this.core = opts.core;
    this.runner = opts.runner;
    this.systemPrompt = opts.systemPrompt ?? "You are a Skill Review Agent. Use tools to look at existing skills, decide what to add/improve, and call skill_create / skill_update / skill_patch / skill_files_write to persist.";
    this.maxIterations = opts.maxIterations ?? 16;
    this.headChars = opts.headChars ?? 8000;
    this.tailChars = opts.tailChars ?? 32000;
    this.maxTokens = opts.maxTokens;
    // The constructor default is 0 (prefix injection off → no extra query-gen LLM call is triggered);
    // production wiring explicitly passes resolved.extraction.prefixSkillsLimit (default 20).
    // <0 or non-numeric falls back to 0 (equivalent to off), rather than silently changing to 20 - we don't want a config error
    // to turn into "an unexpected extra LLM call".
    const rawLimit = opts.prefixSkillsLimit;
    this.prefixSkillsLimit = rawLimit === undefined
      ? 0
      : (Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : 0);
    this.logger = opts.logger;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const { messages } = input;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("ExtractV2: messages must be a non-empty array of ExtractMessage");
    }
    // [obs] one summary event per extraction; the LLM's internal iterations go through the langfuse trace (trace.report
    // → OTel Span → Langfuse SpanProcessor filters and reports); here we only summarize the "entry → exit"
    // duration / candidate count, using task_id as the anchor to align with the worker segment. obsLogger
    // has internal try/catch + FileLogger + backend degradation; even if the logger breaks, extraction itself is unaffected.
    const t0 = Date.now();
    const transcript = formatTranscript(messages);

    const truncated = truncateHeadTail(transcript, this.headChars, this.tailChars);

    // Pre-retrieve the skill list and place it in front of the user prompt, so the review agent can see on entry
    // which skills the agent already owns (avoiding blind skill_create hitting SKILL_NAME_DUPLICATE).
    //
    // Three modes, jointly decided by prefixSkillsLimit + the total number of skills the agent owns:
    //   full     — total ≤ limit: inject all; no query-gen LLM spend.
    //   relevant — total > limit + query-gen succeeds + BM25 hits ≥1: relevance first.
    //   recent   — total > limit + relevant failed (query-gen threw / empty / 0 hits):
    //              fall back to the top-N by updated_at DESC + an "X more not shown" hint.
    //   none     — prefixSkillsLimit=0 or total=0.
    //
    // Key: one core.list({ limit }) gets items + total at once, and all later branches reuse them,
    // with no second DB query; the total ≤ limit scenario skips query-gen directly, so coverage is actually higher.
    let prefixBlock = "";
    let prefixMode: "full" | "relevant" | "recent" | "none" = "none";
    let prefixQuery: string | undefined;
    if (this.prefixSkillsLimit > 0) {
      let recentPage: Awaited<ReturnType<typeof this.core.list>> | null = null;
      try {
        recentPage = await this.core.list({
          user_id: input.user_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          pagination: { limit: this.prefixSkillsLimit },
        });
      } catch (e) {
        // If list fails → the later branches have no data either, go straight into the none branch.
        this.logger?.warn(`${TAG} prefix list failed: ${(e as Error).message}`);
      }
      if (recentPage && recentPage.items.length > 0) {
        if (recentPage.total <= this.prefixSkillsLimit) {
          // Case full: got everything, lay it all out; query-gen is omitted entirely.
          prefixBlock = renderFullSkillsBlock(recentPage.items);
          prefixMode = "full";
        } else {
          // Case relevant: total exceeds limit, spend one LLM query-gen + BM25 to find the most relevant ones.
          try {
            const relevant = await this.buildRelevantSkillsBlock(input, truncated);
            if (relevant) {
              prefixBlock = relevant.block;
              prefixMode = "relevant";
              prefixQuery = relevant.query;
            }
          } catch (e) {
            this.logger?.warn(`${TAG} buildRelevantSkillsBlock failed: ${(e as Error).message}`);
          }
          if (!prefixBlock) {
            // Case recent: relevant failed, fall back to the top-N obtained at the start, with an
            // "X more not shown" hint so the LLM knows it can pull more manually with skill_list.
            prefixBlock = renderRecentSkillsBlock(recentPage.items, recentPage.total);
            prefixMode = "recent";
          }
        }
      }
    }
    let prompt = prefixBlock ? `${prefixBlock}\n\n---\n\n${truncated}` : truncated;

    // Main Agent injects an extraction hint (placed at the very front of the prompt when reason is non-empty)
    if (input.reason && input.reason.trim().length > 0) {
      const hintBlock = [
        "## Extraction hint from the main Agent",
        "Below is the main Agent's note about this conversation; follow its intent closely when extracting:",
        input.reason,
      ].join("\n");
      prompt = `${hintBlock}\n\n---\n\n${prompt}`;
    }

    const auditSink: ExtractedSkillCandidate[] = [];

    if (!this.runner) {
      // No runner injected (test environment / disabled) → return empty candidates
      this.logger?.info(`${TAG} no runner provided; returning empty candidates`);
      obsLogger.info("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: Date.now() - t0,
        msg_count: messages.length,
        candidates: 0,
        skipped: "no_runner",
      });
      return { candidates: [] };
    }

    const tools = createSkillTools({
      core: this.core,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      auditSink,
      logger: this.logger,
    });

    let text: string;
    try {
      text = await this.runner.run({
        prompt,
        systemPrompt: this.systemPrompt,
        tools,
        enableTools: true,
        maxIterations: input.options?.max_iterations ?? this.maxIterations,
        maxTokens: this.maxTokens,
        taskId: `skill-extract-${input.task_id ?? "unknown"}`,
        // Langfuse trace semantics: give this extraction a stable name / filterable tags in the Langfuse UI.
        // See the traceName/tags/sessionId/userId comments of LLMRunParams in core/types.ts.
        traceName: "skill.extract",
        tags: [
          "skill-extract",
          `team:${input.team_id}`,
          `agent:${input.agent_id}`,
        ],
        sessionId: input.session_id,
        userId: input.user_id,
        instanceId: input.space_id,
      });
    } catch (e) {
      // One warn summarizing the failure, including task_id / err_name / dur - the Worker side then decides by category
      // (transient / permanent) whether to requeue or go to the DLQ. The exception is not swallowed here.
      const dur = Date.now() - t0;
      obsLogger.warn("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: dur,
        msg_count: messages.length,
        candidates: auditSink.length,
        err_name: (e as Error).name,
        err_msg: (e as Error).message,
      });
      try {
        trace.report("skill.extractor.extract", {
          task_id: input.task_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          session_id: input.session_id,
          msg_count: messages.length,
          candidates: auditSink.length,
          dur_ms: dur,
          success: false,
          error: (e as Error).message,
        });
      } catch { /* noop */ }
      throw e;
    }

    try { metricProducer.send({ metric: "skill.extract.candidates", instanceId: input.team_id, value: auditSink.length }); } catch { /* noop */ }

    const dur = Date.now() - t0;
    obsLogger.info("skill.extractor.extract", {
      task_id: input.task_id,
      dur_ms: dur,
      msg_count: messages.length,
      candidates: auditSink.length,
      prompt_chars: prompt.length,
      prefix_mode: prefixMode,
      // Truncate to the first 60 characters only (enough to identify keywords; longer is useless for obs).
      prefix_query: prefixQuery ? prefixQuery.slice(0, 60) : undefined,
    });
    try {
      trace.report("skill.extractor.extract", {
        task_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: input.session_id,
        msg_count: messages.length,
        candidates: auditSink.length,
        prompt_chars: prompt.length,
        dur_ms: dur,
        success: true,
      });
    } catch { /* noop */ }

    return { candidates: auditSink, text };
  }

  /**
   * Pre-retrieval of skills that "may be relevant to this conversation": have the runner use one lightweight LLM call to squeeze
   * 2-5 BM25 keywords out of the transcript, then use core.search to get the top-N (limited by
   * prefixSkillsLimit). On success and non-empty → return { block, query }; an empty query
   * / empty search hits / a missing runner all return null so the upstream falls back to recent.
   *
   * Why two steps (rather than folding relevant retrieval directly into the review agent's iteration):
   *   1. give the review agent a concrete candidate pool on entry, instead of groping through a scan first and then searching;
   *   2. query-gen is a short output (≤100 tokens) and does not take up the review agent's context;
   *   3. failures can degrade precisely; running skill_list inside the review agent would only degrade to "all of the owner's",
   *      whereas this function can choose relevant or recent.
   */
  private async buildRelevantSkillsBlock(
    input: ExtractInput,
    transcript: string,
  ): Promise<{ block: string; query: string } | null> {
    if (!this.runner) return null;

    const query = await this.generateSearchQueryFromTranscript(input, transcript);
    if (!query) return null;

    let hits: Awaited<ReturnType<typeof this.core.search>>;
    try {
      hits = await this.core.search({
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        query,
        top_k: this.prefixSkillsLimit,
      });
    } catch (e) {
      this.logger?.warn(`${TAG} relevant search failed for query='${query}': ${(e as Error).message}`);
      return null;
    }
    if (!hits.length) return null;

    const lines = hits.map((h) => formatSkillLine(h.skill.name, h.skill.description));
    const block = [
      `## Skills possibly relevant to this conversation (query='${query}', BM25 prefetched)`,
      "These were retrieved by pre-running skill_list(query=...) against your own skill pool.",
      "If any of these already covers the topic, prefer `skill_update` / `skill_patch` over creating a duplicate.",
      ...lines,
    ].join("\n");
    return { block, query };
  }

  /**
   * Have the runner use one short tool-less LLM call to extract 2-5 BM25 keywords from the transcript.
   * The return value is sanitized (newlines / FTS5 reserved words turned into spaces, an empty string is treated as failure). Exceptions
   * thrown by the runner are always rethrown; the upstream (buildRelevantSkillsBlock) catches them and degrades.
   */
  private async generateSearchQueryFromTranscript(
    input: ExtractInput,
    transcript: string,
  ): Promise<string> {
    if (!this.runner) return "";
    const raw = await this.runner.run({
      systemPrompt: QUERY_GEN_SYSTEM_PROMPT,
      prompt: [
        "Below is a past conversation. Extract 2-5 short English keywords that",
        "capture what the user was trying to do. These will feed a BM25 search over an",
        "existing skill library. Output the keywords on a single line, space-separated,",
        "no punctuation, no labels, no explanation.",
        "",
        "<<transcript>>",
        transcript,
        "<<end-of-transcript>>",
      ].join("\n"),
      enableTools: false,
      // Keep the runner from really running a tool loop; treat it as an ordinary completion.
      maxIterations: 1,
      // Keywords are short; 64 tokens are enough for several words and help the runner return quickly.
      maxTokens: 64,
      taskId: `skill-extract-query-${input.task_id ?? "unknown"}`,
      // On Langfuse you can filter these query-gen calls separately by this traceName, apart from the main skill.extract.
      traceName: "skill.extract.query-gen",
      tags: [
        "skill-extract",
        "skill-extract-query-gen",
        `team:${input.team_id}`,
        `agent:${input.agent_id}`,
      ],
      sessionId: input.session_id,
      userId: input.user_id,
      instanceId: input.space_id,
    });
    return sanitizeGeneratedQuery(raw);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * Serialize ExtractMessage[] into the transcript shown to the Skill Review Agent.
 *
 * Key design (aligned with the "Role isolation" section of SKILL_REVIEW_PROMPT):
 *   - the role prefix uses the unnatural `<<past-xxx>>` double-angle-bracket tag instead of `[user]` / `[assistant]`.
 *     The latter are the native role signals of chat completion, and the model instinctively treats the `[assistant]` at the tail of the transcript
 *     as the anchor for "my turn to continue with the next turn", and directly keeps writing the main agent's reply.
 *     An atypical tag like `<<past-user>>` breaks this hint, letting the model know clearly that "this is historical content I am
 *     reviewing, not a role I am to play".
 *   - append an `<<end-of-transcript>>` anchor + one sentence "now decide per the
 *     output contract in the system prompt" at the end. Without this anchor, when the model sees the transcript end directly
 *     on a long assistant reply, it easily takes the path of "continue with another passage in a similar style".
 *
 * Related background: the docs/2026-07-28 skill extractor role-capture analysis (trace
 * f546ab8c-c7c5-4598-a310-6b2162372e7c, where the extraction LLM completely ignored the SKILL_REVIEW_PROMPT
 * contract and produced a 1235-token continuation of the main conversation, with zero tool calls and zero "Nothing to save.").
 */
function formatTranscript(messages: ExtractMessage[]): string {
  const body = messages.map((m) => `<<past-${m.role}>>\n${m.content}`).join("\n\n");
  return `${body}\n\n<<end-of-transcript>>\nAbove is the past conversation to review. Now decide, and respond only per the output contract in the system prompt.`;
}

function truncateHeadTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n\n... [truncated ${s.length - head - tail} chars] ...\n\n${s.slice(-tail)}`;
}

/**
 * System prompt for "squeeze 2-5 BM25 keywords from the conversation".
 * Key points:
 *   1. state explicitly that these keywords will be fed into BM25 → have the LLM pick high-signal words, not compose full sentences;
 *   2. Mixed-language text is fine; tokenization is Unicode word-based
 *   3. single-line output + no punctuation + no labels; the post-hoc sanitize also enforces this shape.
 */
const QUERY_GEN_SYSTEM_PROMPT = [
  "You are helping build a BM25 keyword query.",
  "Given a past user↔assistant conversation, output 2-5 short high-signal keywords",
  "(as they appear in the transcript) that best represent",
  "what the user was trying to accomplish.",
  "",
  "Rules:",
  "- Output ONLY the keywords, on a single line, separated by single spaces.",
  "- No punctuation, no quotes, no bullets, no labels, no explanation.",
  "- Do NOT invent topics not present in the transcript.",
  "- Prefer nouns / product names / verbs; drop filler words (the, a, please, just).",
  "- If the transcript is empty or has no clear intent, output an empty line.",
].join("\n");

/**
 * Make the generated query valid:
 *   - take only the first line (the LLM sometimes says "Here are the keywords:" first and then a line)
 *   - remove FTS5 reserved words (AND/OR/NOT/NEAR) outright (the BM25 layer falls back to buildFtsQuery)
 *   - remove common punctuation (punctuation makes the BM25 tokenizer jitter)
 *   - collapse whitespace, trim
 *   - conservative length: cap at 120 characters (5 words × ~24 chars)
 * An empty string = the LLM extracted nothing; the upstream falls back to recent.
 */
export function sanitizeGeneratedQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  // A₂-type thinking models (minimax-m3 / GLM-4-thinking / qwq-32b / some vLLM
  // DeepSeek-R1) embed their reasoning as `<think>…</think>` inside content.
  // If it is not stripped first, the first non-empty line of `raw.split(/\r?\n/)` would be `<think>` or think content,
  // and the later punctuation cleanup would turn `<` `>` into spaces → BM25 gets a dirty query, hits 0 → upstream degrades to
  // recent. The business does not break, but pre-retrieval silently fails. Same idea as l1-extractor.ts@ccaa5dc3:
  //   - non-greedy `*?` + mandatory </think> closing: a truncated think tag (stuck at max_tokens)
  //     does not match → kept as is → sanitize later treats it as noise → recent degradation
  //   - `g` flag: strip multiple think segments
  //   - A₁-type (minimax-m2.7 / deepseek-v4-pro / o1 / o3) content has no <think>,
  //     replace is a no-op → byte-for-byte equivalent, backward-compatible.
  raw = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  // Take only the first non-empty line - the LLM occasionally adds a line of metadata before or after the keywords.
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return "";
  // Strip common punctuation / FTS5 reserved words. Replace with spaces rather than delete, so "foo,bar" does not become "foobar".
  const noPunct = firstLine
    .replace(/[,;:!?"'`()\[\]{}<>|/\\*+=~@#$%^&]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  const collapsed = noPunct.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? collapsed.slice(0, 120).trimEnd() : collapsed;
}

/**
 * Assemble one line "- name — description truncated to 100 chars". An empty description falls back to "- name".
 * Shared by the recent / relevant / full blocks, to avoid the line format drifting.
 */
function formatSkillLine(name: string, description?: string): string {
  const desc = (description ?? "").trim().replace(/\s+/g, " ");
  const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  return short ? `- ${name} — ${short}` : `- ${name}`;
}

/**
 * The "full" prefix block - the agent's total skill count ≤ prefixSkillsLimit, laid out directly.
 * Semantically tells the LLM "these are all your skills, none omitted", a stronger prior than the recent section.
 * There is no truncated hint on reuse (because nothing was truncated).
 */
function renderFullSkillsBlock(items: Array<{ name: string; description?: string }>): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  return [
    `## Skills you (this agent) own (${items.length} total — full list, no truncation)`,
    "This is your entire skill inventory. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.",
    ...lines,
  ].join("\n");
}

/**
 * The "recently updated" prefix block - the fallback when the relevant branch fails. It comes with an "X more not shown"
 * hint, so the LLM knows it can actively pull more with skill_list(query=...).
 */
function renderRecentSkillsBlock(
  items: Array<{ name: string; description?: string }>,
  total: number,
): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  const omitted = total - items.length;
  const header = `## Skills you (this agent) own (${items.length} most-recently-updated of ${total} total, prefetched via skill_list)`;
  const hint = omitted > 0
    ? `Most recent first. ${omitted} more not shown — call skill_list(query=...) to search the rest. Consider \`skill_update\` / \`skill_patch\` on an existing skill before creating a new one.`
    : "Most recent first. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.";
  return [header, hint, ...lines].join("\n");
}

// ═════════════════════════════════════════════════════════════════════
//  ISkillExtractor adapter — lets SkillConversationExtractWorker (agent queue)
//  drive the V2 extractor. The ISkillExtractor interface held by the Worker accepts
//  conversation: ConversationMessage[] + agent_id; here it is mapped into the V2
//  ExtractMessage[] form.
// ═════════════════════════════════════════════════════════════════════

const ALLOWED_ROLES = new Set(["user", "assistant", "tool_call", "tool_result"]);

function toExtractMessages(conv: ConversationMessage[]): ExtractMessage[] {
  return conv.map((m) => ({
    role: (ALLOWED_ROLES.has(m.role) ? m.role : "user") as ExtractMessage["role"],
    content: m.content,
  }));
}

function toLegacyCandidates(items: ExtractedSkillCandidate[]): ExtractedCandidate[] {
  return items.map((c) => ({
    action: c.action as ExtractedCandidate["action"],
    name: c.name,
    skill_id: c.skill_id,
    version: c.version,
    description: c.description,
    confidence: c.confidence,
    reason: c.reason,
    file_path: c.file_path,
    file_type: c.file_type,
  }));
}

/**
 * Wrap SkillExtractor as an ISkillExtractor, so SkillConversationExtractWorker
 * (agent queue) can drive it directly.
 *
 * The input input.agent_id must be provided by the caller (at trigger.archive time), sourced from
 * SkillTaskEntry.agent_id. When missing, return empty candidates and emit a warn log - extraction depends on the owner
 * check, and without an agent_id it cannot be persisted.
 */
export function createExtractorAdapter(
  v2: SkillExtractor,
  logger?: { warn(msg: string): void },
): ISkillExtractor {
  return {
    async extract(input) {
      const agentId = (input as { agent_id?: string }).agent_id;
      if (!agentId) {
        logger?.warn(
          `${TAG} V2 adapter: input.agent_id missing — skipping extract (returns empty candidates)`,
        );
        return { candidates: [] };
      }
      const r = await v2.extract({
        user_id: input.user_id ?? "",
        team_id: input.team_id,
        agent_id: agentId,
        task_id: input.task_id ?? input.taskId,
        // Langfuse trace binding fields: passed through here after the Worker reads them from SkillTaskEntry;
        // when missing, the trace gets sessionId=null / instanceId=unknown (cannot be filtered by session).
        session_id: input.session_id,
        space_id: input.space_id,
        messages: toExtractMessages(input.conversation),
        reason: (input as { reason?: string }).reason,
        options: (input as { options?: { max_iterations?: number } }).options,
      });
      return { candidates: toLegacyCandidates(r.candidates) };
    },
  };
}
