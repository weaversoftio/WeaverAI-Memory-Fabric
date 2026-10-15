/**
 * Codex Session Init Form — `request_user_input` function_call.
 *
 * Codex client form protocol:
 *   - Tool name: `request_user_input`
 *   - Parameters: `{questions: [{prompt, options?}, ...]}`
 *   - Protocol: OpenAI Responses API (SSE `response.*` event sequence)
 *   - ID prefix: `call_codex_session_init_`
 *   - Plan mode gating: in Default mode the client gate intercepts and returns
 *     `"request_user_input is unavailable in Default mode"`
 *
 * Contains no Claude Code / CodeBuddy logic.
 */

import type { TeamOption } from "../types.js";
import { computeCodexPagination } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "request_user_input";
/**
 * `function_call.call_id` prefix -- when the codex client replays the form result back into input[],
 * it uses `call_id` to associate with `function_call_output`; the OpenAI Responses spec
 * allows a free format for this field, and on read-back this prefix identifies whether it is session-init.
 */
export const TOOLCALL_PREFIX = "call_codex_session_init_";
/**
 * `function_call.id` prefix -- the OpenAI Responses spec strictly requires `id` to start with `fc`
 * (`fc_xxxxxxxxxxxx`). Previously id also used TOOLCALL_PREFIX (starting with call_),
 * and an upstream Responses API that strictly enforces the spec returns 400 when the client replays it into input[]:
 *   Invalid 'input[N].id': 'call_codex_session_init_xxx'.
 *   Expected an ID that begins with 'fc'.
 * See the 2026-08-13 user packet-capture error report. call_id keeps the call_ prefix; only id uses fc_.
 */
export const TOOLCALL_ID_PREFIX = "fc_codex_session_init_";

export const TEAM_FORM_TITLE = "Session setup — choose a Team";
export const AGENT_TASK_FORM_TITLE = "Session setup — choose Agent and Task";
export const RETRY_FORM_TITLE = "Selection not recognised, please choose again";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, not this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session setup — link team assets?";

/**
 * Stable marker of the codex pagination "More..." option (written into option.label; when the user clicks it, it
 * returns as is to the codex handler, and we intercept it accordingly -> pageIndex++ and re-send the next page form).
 *
 * MARKER is a stable string for internal identification (naming aligned with CC MORE_MARKER); LABEL is
 * the user-facing readable text ("More..."). At extract time, matching by LABEL substring is enough,
 * and MARKER itself does not go into the label (avoids "__..." characters polluting the UI display).
 */
export const CODEX_MORE_MARKER = "__codex_more_marker__" as const;
export const CODEX_MORE_LABEL = "More...";

/**
 * Prefix string intercepted by the client's gate in Default mode.
 * When `function_call_output.output` starts with this, it is judged a gate hit.
 */
export const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in";

/**
 * General note appended to the end of each step's question.
 * Codex's request_user_input shows questions + options to the user in Plan mode;
 * the skip entry is the "No, not this time" button. The wording is unified across claude-code/workbuddy/codebuddy/dsh.
 */
const SKIP_HINT = ' (Pick the closest option; typing your own answer is not supported yet. If you choose No, no team assets are injected into this session.)';

/** Returns true if the given string contains any codex form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a function_call id belongs to a codex session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

/**
 * Decide whether `function_call_output.output` is a client Default-mode gate interception.
 * The gate string startsWith `"request_user_input is unavailable in"`.
 */
export function isDefaultModeGate(output: string): boolean {
  return output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

/**
 * Stage enum supported by the codex form.
 *
 * 2026-08-08 refactor: the old "agent_task" (asking agent+task together in one shot) is split on the codex side into
 * two independent stages: "agent_select" asks only the agent, "task_select" asks only the task. For the reason see
 * docs & task-brief: the old stage made partialMore (agent really chosen + task=more) unable to return to
 * the same stage to re-ask the task, so the user paging always saw the first page.
 *
 * The old "agent_task" value is kept (for the legacy path when the CB client reuses the CB state machine and for old
 * unit tests); new codex sessions no longer use it.
 */
export type FormStage = "asset_confirm" | "team" | "agent_select" | "task_select" | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /**
   * The agent_id already chosen at the agent_select stage. When the task_select stage renders the task list,
   * this field is currently only used for logging / echo -- tasks are team-wide and not affected by the agent.
   * It can be put to use directly if agent-scoped task lists are introduced in the future.
   */
  selectedAgentId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * codex pagination page numbers (0-based). The three stages are independent of each other:
   *   - teamPage:  team stage
   *   - agentPage: agent_select stage (and the agent question of legacy agent_task)
   *   - taskPage:  task_select stage (and the task question of legacy agent_task)
   *
   * All default to 0 when omitted. The codex handler reads codexPageIndex from the sessionStore
   * and passes it down; when the user answers "More...", the handler intercepts and re-sends with +1.
   */
  teamPage?: number;
  agentPage?: number;
  taskPage?: number;
}

// ── Answer extraction ────────────────────────────────────────────────────────

/**
 * Extract the `function_call_output` of the session-init form in codex `body.input[]`
 * into CB-compatible `messages[]` (one `role: "user"` message whose content is the concatenated answer
 * text), so as to reuse CB's `handleSessionInit` state machine (no need to build another codex-side
 * extractor / state machine).
 *
 * Only take the **last** `function_call_output` whose call_id starts with `call_codex_session_init_`,
 * because the codex client replays input[] in full, accumulating the answers of multiple form rounds;
 * the CB state machine only cares about the latest step each time.
 *
 * `output` may be:
 *   - a plain string answer: `"Yes, link team assets"`
 *   - a JSON string `{"answers":{"q1":"Yes"}}` (may differ between codex client versions)
 *   - a JSON string `{"question":"...","answer":"..."}` or an array
 * Fallback strategy: if a structured answer value can be parsed, concatenate and return it, otherwise use the raw string directly.
 *
 * Returning an empty array -> CB goes through the retry/fallback logic of the `pending_*` branch.
 */
export function codexFormAnswersAsMessages(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }

  if (lastOutput === null) return [];

  const text = extractAnswerText(lastOutput);
  if (!text) return [];

  return [{ role: "user", content: text }];
}

/**
 * Try to extract the answer text from codex `function_call_output.output`.
 *
 * The tool_result structure of codex `request_user_input` differs slightly across client versions / languages --
 * first try JSON parsing for several common shapes; if none match, fall back to the raw string (CB's
 * matcher is a substring fallback anyway, so hitting the option label is enough).
 */
function extractAnswerText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Non-JSON prefix -> return as is.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    const collected: string[] = [];
    collectAnswerStrings(parsed, collected);
    if (collected.length > 0) return collected.join("\n");
  } catch {
    // JSON parse failed -> fall back to the raw string
  }
  return trimmed;
}

/**
 * Scan the last session-init form's `function_call_output` in codex `body.input[]`,
 * and extract which MORE markers were hit by question id.
 *
 * Usage: intercept before handleSessionInit -- on a hit, pageIndex+1 and
 * re-send the form directly, without advancing the CB state machine.
 *
 * Returns:
 *   - hasMore: at least one question's answer contains CODEX_MORE_LABEL
 *   - perQuestion: whether each question id hit MORE
 *
 * Aligned with `codexFormAnswersAsMessages`: only take the last `function_call_output`
 * whose call_id starts with `call_codex_session_init_`.
 *
 * Compatible with multiple output formats:
 *   - plain string (single question)
 *   - JSON: `{"answers":{"team_select":"More..."}}`
 *   - JSON: `{"answers":{"agent_select":"agent-1","task_select":"More..."}}`
 *   - JSON: multi_question_result envelope
 *
 * Formats that cannot be parsed degrade to "check only the CODEX_MORE_LABEL substring in the plain string" --
 * in which case perQuestion is all false (the caller decides by state.status which one to bump).
 */
export interface CodexMoreDetection {
  hasMore: boolean;
  perQuestion: {
    team_select: boolean;
    agent_select: boolean;
    task_select: boolean;
  };
}

export function detectCodexMore(input: unknown): CodexMoreDetection {
  const result: CodexMoreDetection = {
    hasMore: false,
    perQuestion: { team_select: false, agent_select: false, task_select: false },
  };
  if (!Array.isArray(input)) return result;

  let lastOutput: string | null = null;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const callId = it.call_id;
    if (typeof callId !== "string" || !callId.startsWith(TOOLCALL_PREFIX)) continue;
    const output = it.output;
    if (typeof output === "string") lastOutput = output;
  }
  if (lastOutput === null) return result;

  const trimmed = lastOutput.trim();
  if (!trimmed) return result;

  // Try structured parsing
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      collectMorePerQuestion(parsed, result);
    } catch {
      // ignore
    }
  }

  // Fallback: substring match over the whole text
  if (lastOutput.includes(CODEX_MORE_LABEL)) {
    result.hasMore = true;
  }
  // If structured parsing hit any perQuestion, hasMore must be set too
  if (
    result.perQuestion.team_select ||
    result.perQuestion.agent_select ||
    result.perQuestion.task_select
  ) {
    result.hasMore = true;
  }

  return result;
}

function collectMorePerQuestion(node: unknown, out: CodexMoreDetection): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // { answers: { q_id: label } }
  if (obj.answers && typeof obj.answers === "object") {
    const answers = obj.answers as Record<string, unknown>;
    for (const [qid, val] of Object.entries(answers)) {
      if (typeof val !== "string") continue;
      if (!val.includes(CODEX_MORE_LABEL)) continue;
      if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
        (out.perQuestion as Record<string, boolean>)[qid] = true;
      }
    }
  }

  // { type: "multi_question_result", questions: [{id, answer}] }
  const mqr = (obj.result ?? obj) as Record<string, unknown> | undefined;
  if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
    for (const q of mqr.questions) {
      if (!q || typeof q !== "object") continue;
      const qo = q as Record<string, unknown>;
      const qid = typeof qo.id === "string" ? qo.id : "";
      const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
      let val: string | null = null;
      if (typeof cand === "string") val = cand;
      else if (Array.isArray(cand)) {
        const f = cand.find((x) => typeof x === "string");
        if (typeof f === "string") val = f;
      }
      if (val && val.includes(CODEX_MORE_LABEL)) {
        if (qid === "team_select" || qid === "agent_select" || qid === "task_select") {
          (out.perQuestion as Record<string, boolean>)[qid] = true;
        }
      }
    }
  }
}

function collectAnswerStrings(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectAnswerStrings(item, out);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Priority keys: answers / answer / value / selection
    for (const key of ["answers", "answer", "value", "selection", "selected"]) {
      if (key in obj) {
        collectAnswerStrings(obj[key], out);
        return;
      }
    }
    // Otherwise walk all values (defensive; questions[].answer style)
    for (const v of Object.values(obj)) collectAnswerStrings(v, out);
  }
}

// ── Question builder ─────────────────────────────────────────────────────────
//
// Codex `request_user_input` schema (the official definition dug out of the codex system prompt):
//
//   {
//     questions: [1..3 items],        the top level may carry only 1~3 questions
//     each question: {
//       id: string (snake_case, required),
//       header: string (≤ 12 chars, required),
//       question: string (required),  <- note the field name is not prompt
//       options: [2..3 items],        each question allows only 2-3 options
//       each option: { label, description } (both required)
//     }
//   }
//
// The client automatically appends an "Other" option as a free-input fallback; we must not stuff it ourselves.
// If there are more than 3 options (e.g. a long team/agent/task list) -> keep only the first 2 labels,
// and a user who wants one of the rest uses "Other" to type the id/name by hand.
//
// See docs/2026-08-05-codex-onboarding.md §7.5.3.

interface CodexOption {
  label: string;
  description: string;
}

interface CodexQuestion {
  id: string;       // snake_case stable identifier
  header: string;   // <= 12 chars UI label
  question: string; // the full question shown to the user
  options: CodexOption[];
}

/** Truncate header to <= 12 chars (wide characters count as 1 char — codex is not explicit, so conservatively count by characters). */
function clampHeader(s: string): string {
  return s.length <= 12 ? s : s.slice(0, 12);
}

/**
 * Build options with pagination: split entries into pages by codex's 3-slot cap; non-last pages
 * get a "More..." option appended at the tail for the user to page; the last page has no MORE and lists the remainder directly.
 *
 * - entries.length <= 3 && single page -> as is
 * - middle pages: first 2 real + MORE (3 items; the client's "Other" slot is separate)
 * - last page: the remaining 2~3 real
 * - entries.length === 0: fall back to 2 placeholder items (codex requires >= 2)
 * - entries.length === 1: the real item + a "Skip" placeholder (codex requires >= 2)
 */
function buildOptions(
  entries: Array<{ label: string; description: string }>,
  pageIndex: number,
): CodexOption[] {
  if (entries.length === 0) {
    return [
      { label: "Skip", description: "Start the conversation without linking" },
      { label: "Retry", description: "Reload the list and choose again" },
    ];
  }
  if (entries.length === 1) {
    return [
      entries[0]!,
      { label: "Skip", description: "Start the conversation without linking" },
    ];
  }

  const safePage = Math.max(0, pageIndex);
  const page = computeCodexPagination(entries.length, safePage);
  const slice = entries.slice(page.start, page.end);

  if (page.isLastPage) {
    return slice;
  }

  const remaining = page.total - page.end;
  const morePageNo = safePage + 2; // human-facing (1-based, next page)
  const moreOption: CodexOption = {
    label: CODEX_MORE_LABEL,
    description: `Show the next batch (page ${morePageNo}/${page.totalPages}, ${remaining} more)`,
  };
  return [...slice, moreOption];
}

function pageSuffix(pageIndex: number, totalPages: number): string {
  return totalPages > 1 ? ` (page ${pageIndex + 1}/${totalPages})` : "";
}

function buildQuestions(data: FormData): CodexQuestion[] {
  const { teams, stage, selectedTeamId, retry } = data;
  const retryHint = retry ? " (last answer not recognised, please choose again)" : "";
  const teamPage = Math.max(0, data.teamPage ?? 0);
  const agentPage = Math.max(0, data.agentPage ?? 0);
  const taskPage = Math.max(0, data.taskPage ?? 0);

  if (stage === "asset_confirm") {
    return [{
      id: "asset_confirm",
      header: clampHeader("Link assets?"),
      question: `Link team assets (Skill / Memory / Agent / Task / Knowledge) to this conversation?${retryHint}`,
      options: [
        {
          label: ASSET_CONFIRM_YES,
          description: "Next you choose a Team, Agent and Task; after that the relevant assets are injected into every turn.",
        },
        {
          label: ASSET_CONFIRM_NO,
          description: "Start this conversation without team assets.",
        },
      ],
    }];
  }

  if (stage === "team") {
    const entries = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: `Team ID: ${t.team_id}${t.agents?.length ? `, ${t.agents.length} Agents` : ""}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, teamPage);
    return [{
      id: "team_select",
      header: clampHeader("Team"),
      question: `Which Team is this session for${pageSuffix(teamPage, pageInfo.totalPages)}?${retryHint}`,
      options: buildOptions(entries, teamPage),
    }];
  }

  // stage in { "agent_select", "task_select", "agent_task" (legacy) }
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return [];

  const questions: CodexQuestion[] = [];

  // Agent question -- both the new stage "agent_select" and legacy "agent_task" render it.
  if ((stage === "agent_select" || stage === "agent_task") && team.agents.length > 0) {
    const entries = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: `Agent ID: ${a.agent_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, agentPage);
    questions.push({
      id: "agent_select",
      header: clampHeader("Agent"),
      question: `Which Agent in "${team.team_name}" should be used${pageSuffix(agentPage, pageInfo.totalPages)}?${retryHint}`,
      options: buildOptions(entries, agentPage),
    });
  }

  // Task question -- both the new stage "task_select" and legacy "agent_task" render it.
  if ((stage === "task_select" || stage === "agent_task") && team.tasks.length > 0) {
    const entries = team.tasks.map((t) => ({
      label: t.isDefault ? t.task_name : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: t.isDefault
        ? "This Agent's default task (recommended)"
        : `Task ID: ${t.task_id}`,
    }));
    const pageInfo = computeCodexPagination(entries.length, taskPage);
    const opts = buildOptions(entries, taskPage);
    questions.push({
      id: "task_select",
      header: clampHeader("Task"),
      question: `Which Task in "${team.team_name}" is this session for${pageSuffix(taskPage, pageInfo.totalPages)}?${retryHint}`,
      options: opts,
    });
  }

  return questions;
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Codex `request_user_input` fake form response.
 * Supports both SSE streaming (Responses API events) and non-streaming JSON.
 */
export function buildFormResponse(data: FormData): Response {
  const questions = buildQuestions(data);
  const argsJson = JSON.stringify({ questions });

  // `id` and `call_id` are two independent fields in the OpenAI Responses spec:
  //   - id     : the function_call item's own unique identifier; the spec requires an `fc` prefix
  //   - call_id: the correlation key pairing a function_call with the subsequent function_call_output;
  //              the spec allows a free format. The read-back side (codexFormAnswersAsMessages /
  //              extractCodexMoreFlags) uses call_id.startsWith(TOOLCALL_PREFIX)
  //              to identify session-init, so call_id still uses the call_ prefix.
  const ts = Date.now();
  const fcId = TOOLCALL_ID_PREFIX + ts;
  const callId = TOOLCALL_PREFIX + ts;
  const responseId = "resp_codex_session_init_" + ts;

  if (data.stream) {
    return buildStreamingResponse(responseId, fcId, callId, argsJson);
  }
  return buildNonStreamingResponse(responseId, fcId, callId, argsJson);
}

// ── Non-streaming ────────────────────────────────────────────────────────────

function buildNonStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const body = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: fcId,
        name: TOOL_NAME,
        arguments: argsJson,
        call_id: callId,
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Streaming (Responses API SSE) ────────────────────────────────────────────

function buildStreamingResponse(
  responseId: string,
  fcId: string,
  callId: string,
  argsJson: string,
): Response {
  const encoder = new TextEncoder();
  // Key: in the Responses API every event's data JSON **must** carry a `type` field
  // (same name as the SSE `event:` header), otherwise the codex client parser cannot read the event type,
  // and the symptom is that the tool_call does not reach the client UI (the form does not pop up). Aligned with the real upstream behaviour in capture notes section 7.5.2/3.
  const sse = (event: string, d: Record<string, unknown>) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...d })}\n\n`);

  const functionCallItem = {
    type: "function_call" as const,
    id: fcId,
    name: TOOL_NAME,
    arguments: argsJson,
    call_id: callId,
  };

  const responseObj = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [functionCallItem],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  const stream = new ReadableStream({
    start(controller) {
      // response.created
      controller.enqueue(sse("response.created", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.in_progress
      controller.enqueue(sse("response.in_progress", {
        response: { ...responseObj, status: "in_progress", output: [] },
      }));

      // response.output_item.added (function_call) -- arguments start as an empty string,
      // generated as a stream via arguments.delta (aligned with the real upstream frame sequence)
      controller.enqueue(sse("response.output_item.added", {
        output_index: 0,
        item: { ...functionCallItem, arguments: "" },
      }));

      // response.function_call_arguments.delta -- key: the real upstream event carries
      // item_id to align with item.id in output_item.added; without item_id the client
      // cannot attach the delta back to the corresponding tool call. item.id is now fcId (fc_ prefix),
      // and item_id must come from the same source.
      controller.enqueue(sse("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: fcId,
        delta: argsJson,
      }));

      // response.function_call_arguments.done
      controller.enqueue(sse("response.function_call_arguments.done", {
        output_index: 0,
        item_id: fcId,
        arguments: argsJson,
      }));

      // response.output_item.done (function_call complete)
      controller.enqueue(sse("response.output_item.done", {
        output_index: 0,
        item: functionCallItem,
      }));

      // response.completed
      controller.enqueue(sse("response.completed", {
        response: responseObj,
      }));

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
