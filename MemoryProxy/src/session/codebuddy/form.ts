/**
 * CodeBuddy Session Init Form — `ask_followup_question` tool_call.
 *
 * CodeBuddy form that renders clickable buttons:
 *   - Tool name: `ask_followup_question`
 *   - Options: flat string list, no limit on count
 *   - Protocols: OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)
 *   - ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
 *
 * Contains no Claude Code logic.
 */

import type { TeamOption } from "../types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "ask_followup_question";
export const TOOLCALL_PREFIXES = ["call_session_init_", "toolu_session_init_"] as const;

export const TEAM_FORM_TITLE = "Session setup — choose a Team";
export const AGENT_TASK_FORM_TITLE = "Session setup — choose Agent and Task";
export const RETRY_FORM_TITLE = "Selection not recognised, please choose again";
/** Overall title kept for compatibility with old tests (used by cleaner.ts detection). */
export const COMBINED_FORM_TITLE = "Session setup — choose Team / Agent / Task";

export const SKIP_LABEL = "Skip this time (no injection, pass straight through)";
export const PATH_SEP = " / ";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, not this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session setup — link team assets?";

/**
 * General note appended to the end of each step's question.
 * CodeBuddy is a button-style form; the only skip entry is choosing "No" at the initial asset_confirm step;
 * after entering team / agent_task there is no in-button skip, and the user must re-select in the next session.
 * The wording is unified across claude-code/workbuddy/codex/dsh.
 */
const SKIP_HINT = ' (Pick the closest option; typing your own answer is not supported yet. If you choose No, no team assets are injected into this session.)';

/** Returns true if the given string contains any CodeBuddy form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(COMBINED_FORM_TITLE) ||
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a CodeBuddy session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return TOOLCALL_PREFIXES.some((p) => id.startsWith(p));
}

// ── Form Data ──────────────────────────────────────────────────────────────────

/**
 * Stages supported by the CB form.
 *
 * The CB client only uses "asset_confirm" | "team" | "agent_task" (agent+task asked together in one shot).
 * After the 2026-08-08 stage split, the codex client reusing the CB state machine additionally goes through the "agent_select"
 * and "task_select" sub-stages -- the stage field of the CB exit formData is carried on to the
 * codex handler, and `buildCodexFormResponse` uses stage to decide which question to render.
 *
 * CB's own `buildFollowupQuestionArgs` renders agent_select/task_select with the "ask only
 * one" semantics; the CB client never reaches here on the codex-only path (the real render
 * exit is codex form.ts); the branch is kept only as a defensive fallback & for CB-side unit tests.
 */
export type FormStage =
  | "asset_confirm"
  | "team"
  | "agent_select"
  | "task_select"
  | "agent_task";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /**
   * codex-only: the agent_id chosen at the agent_select stage, passed through to the task_select stage
   * form. The CB client itself does not use it (CB asks agent+task together in one shot).
   */
  selectedAgentId?: string;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  protocol?: "openai" | "anthropic";
  /**
   * Used only for agentSource="codex": the pagination page number the CB state machine passes through to the downstream codex form for re-rendering.
   * The CB client itself does not render pagination (`ask_followup_question` has no limit on option
   * count); filling the field does not affect CB output.
   */
  teamPage?: number;
  agentPage?: number;
  taskPage?: number;
  /**
   * true = questions is passed as a real array (CB v1.106+); false = passed as a JSON string (old versions).
   * Defaults to true when unset.
   */
  questionsAsArray?: boolean;
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * CB v1.106+'s ask_followup_question schema requires `questions` to be a real array (no longer accepts
 * a JSON string). Old versions (v1.105-) expect questions as a JSON string.
 * FormData.questionsAsArray decides which path to take, defaulting to true (new version).
 */
function buildFollowupQuestionArgs(data: FormData): { title: string; questions: Array<Record<string, unknown>> | string } {
  const asArray = data.questionsAsArray !== false;
  const { teams, stage, selectedTeamId, retry } = data;

  const title = retry
    ? "⚠️ " + RETRY_FORM_TITLE
    : stage === "asset_confirm"
      ? ASSET_CONFIRM_FORM_TITLE
      : stage === "team"
        ? TEAM_FORM_TITLE
        : AGENT_TASK_FORM_TITLE;

  const questions: Array<{
    id: string;
    question: string;
    options: string[];
    multiSelect: boolean;
  }> = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: "Link team assets to this conversation?" + SKIP_HINT,
      options: [ASSET_CONFIRM_YES, ASSET_CONFIRM_NO],
      multiSelect: false,
    });
    return { title, questions: asArray ? questions : JSON.stringify(questions) };
  }

  if (stage === "team") {
    questions.push({
      id: "team",
      question: "Which Team is this session for?" + SKIP_HINT,
      options: [
        ...teams.map((t) => `${t.team_name} (${t.team_id.slice(-8)})`),
      ],
      multiSelect: false,
    });
    return { title, questions: asArray ? questions : JSON.stringify(questions) };
  }

  // stage in { "agent_task" (CB one-shot), "agent_select" / "task_select"
  // (codex-only split). The CB client never goes through the latter two stages -- the codex handler re-renders
  // with codex form.ts and does not call CB `buildFollowupQuestionArgs`. The branches are kept
  // as a defensive fallback so that the CB fallback render can also produce a valid structure.
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { title, questions: asArray ? questions : JSON.stringify(questions) };

  const wantAgent = stage === "agent_task" || stage === "agent_select";
  const wantTask = stage === "agent_task" || stage === "task_select";

  if (wantAgent && team.agents.length > 0) {
    const agentLabelOptions = [
      ...team.agents.map((a) => `${a.agent_name} (${a.agent_id.slice(-8)})`),
    ];
    questions.push({
      id: "agent",
      question: `Which Agent in "${team.team_name}" should be used?` + SKIP_HINT,
      options: agentLabelOptions,
      multiSelect: false,
    });
  }

  if (wantTask) {
    const taskOptions: string[] = [];
    for (const tk of team.tasks) {
      // Virtual fallback entries (isDefault) get no id suffix; there is only one, so no name ambiguity.
      if (tk.isDefault) {
        taskOptions.push(tk.task_name);
      } else {
        taskOptions.push(`${tk.task_name} (${tk.task_id.slice(-8)})`);
      }
    }
    if (taskOptions.length > 0) {
      questions.push({
        id: "task",
        question: `Which Task in "${team.team_name}" is this session for?` + SKIP_HINT,
        options: taskOptions,
        multiSelect: false,
      });
    }
  }

  return { title, questions: asArray ? questions : JSON.stringify(questions) };
}

/**
 * Build a fake form response (OpenAI or Anthropic protocol).
 * CodeBuddy supports dual protocols:
 *   - protocol="openai": tool_calls chunk stream or JSON
 *   - protocol="anthropic": tool_use SSE stream or JSON
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const args = buildFollowupQuestionArgs(data);

  if (data.protocol === "anthropic") {
    const msgId = "msg_session_init_" + Date.now();
    const toolUseId = "toolu_session_init_" + Date.now();
    if (data.stream) {
      return buildAnthropicStreamingResponse(msgId, model, toolUseId, args);
    }
    return buildAnthropicNonStreamingResponse(msgId, model, toolUseId, args);
  }

  const id = "session-init-" + Date.now();
  const toolCallId = "call_session_init_" + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, args);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, args);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: JSON.stringify(args),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  const encoder = new TextEncoder();
  const argsStr = JSON.stringify(args);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

// ── Anthropic Non-streaming ────────────────────────────────────────────────────

function buildAnthropicNonStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: TOOL_NAME,
      input: args,
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Anthropic Streaming ────────────────────────────────────────────────────────

function buildAnthropicStreamingResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  args: { title: string; questions: string | Array<Record<string, unknown>> },
): Response {
  const encoder = new TextEncoder();
  const inputJson = JSON.stringify(args);
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: TOOL_NAME, input: {} },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
