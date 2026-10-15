/**
 * dsh Session Init Form -- `ask_user_question` tool_call carrier.
 *
 * In preset scenarios (web-app + standard/code/cordis and other presets), the dsh (deepseek-harness) client
 * automatically mounts `@deepseek-ai/dsh-tool-ask-user`, adding an
 * `ask_user_question` tool to the main conversation's tools array (see the dsh source
 * `packages/interaction/tool-ask-user/src/index.ts`).
 *
 * The proxy-side session-init form directly reuses this dsh native tool name, faking an
 * assistant tool_call SSE so that the client UI renders the options.
 *
 * # Differences from the workbuddy form (3 shape differences + tool name)
 *   - tool_name: `AskUserQuestion` → `ask_user_question`
 *   - multiSelect (camelCase) → multi_select (snake_case)
 *   - every question requires an `id` (a hard dsh schema constraint, echoed in answer)
 *   - the top-level `questions[]` can carry multiple questions at once (workbuddy/CC usually ask a single one; the array structure is
 *     kept here to align with the dsh schema, a single question being a one-element array)
 *
 * # Transport
 *   - protocol = **OpenAI /v1/chat/completions** (consistent with the dsh client's fetch)
 *   - SSE stream or non-stream (consistent with the request's `body.stream`)
 *   - skeleton copied entirely from workbuddy (chunk 1 = role+tool_call decl / chunk 2 =
 *     arguments delta / chunk 3 = finish_reason:tool_calls / DONE)
 *
 * # State machine
 *   - fully reuses the CB state machine (session/codebuddy/init.ts), same pattern as workbuddy;
 *     stage values (asset_confirm / team / agent_select / task_select / agent_task)
 *     are identical to CB and passed through directly
 *
 * # tool_call id prefix
 *   - `call_dsh_session_init_` -- distinguishes from CB (`call_session_init_`),
 *     workbuddy (`call_wb_session_init_`), codex (`fc_codex_session_init_`)
 *
 * # Packet-capture schema basis
 *   - `docs/dsh-recon/fixtures/dsh-tool-catalog-schema.json`
 *   - dsh source `packages/interaction/tool-ask-user/src/index.ts`
 */

import type { TeamOption } from "../types.js";
// dsh (deepseek-harness)'s ask_user_question UI has no cap on the number of options
// (the source packages/interaction/tool-ask-user/src/index.ts + UI QuestionComposer.tsx
// both map-render directly, with no truncation). So the dsh form **does not paginate**; team/agent/task are all stuffed in.
// By comparison: CC hard-requires <= 4 options (internal AskUserQuestion validation) and must paginate; codex has a similar
// limit; CB has no limit and does not paginate. dsh belongs to the "UI has no limit" class.
// See: MemoryProxy/docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #9.

// ── Constants ──────────────────────────────────────────────────────────────────

/** dsh native tool name. **Do not** change it to CC's `AskUserQuestion` -- the dsh preset mounts the snake_case one. */
export const TOOL_NAME = "ask_user_question";
export const TOOLCALL_PREFIX = "call_dsh_session_init_";

export const TEAM_FORM_TITLE = "Session setup — choose a Team";
export const AGENT_TASK_FORM_TITLE = "Session setup — choose Agent and Task";
export const RETRY_FORM_TITLE = "Selection not recognised, please choose again";

export const SKIP_LABEL = "Skip this time (no injection, pass straight through)";
// dsh does not paginate; MORE_LABEL is kept only for backward compatibility (for tests or a future switch to pagination); currently not produced.
export const MORE_LABEL = "More →";

/**
 * Placeholder reasoning_content of the fake tool_call assistant message.
 *
 * ## Why it must be non-empty
 *
 * dsh `serialize.ts:99` only passes reasoning_content back into the upstream body when `toolCalls.length > 0 && reasoning.length > 0`.
 * dsh `translate.ts:133` inbound parsing is the same:
 * only `reasoning_content.length > 0` opens a reasoning block -- **an empty string is swallowed outright**.
 *
 * Empty string `""` = the client parses a block with `text: ""` -> after serialize join the length is 0
 * -> the upstream body lacks reasoning_content -> deepseek thinking mode hard-validates and returns 400
 * `The reasoning_content in the thinking mode must be passed back to the API`.
 *
 * Stuffing in a non-empty placeholder makes the client really open a reasoning block, which is carried along on the next round's replay.
 * The value itself has no effect on the model (the fake session-init never really goes through the model anyway).
 *
 * See docs/dsh-recon/2026-08-14-dsh-integration-notes.md pitfall #7.
 */
const REASONING_PLACEHOLDER = "[proxy session-init form]";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, not this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session setup — link team assets?";

/**
 * General note appended to the end of each step's question.
 * dsh's ask_user_question UI also supports an "Other" / free-text fallback (see dsh doc section 3.4
 * `custom` field); replying "skip / do not link" goes through the SKIP_RE bypass.
 * The wording is unified across claude-code/workbuddy/codex/codebuddy/dsh.
 */
const SKIP_HINT = ' (Pick the closest option; typing your own answer is not supported yet. If you choose No, no team assets are injected into this session.)';

/** Returns true if the given string contains any dsh form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a dsh session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** @deprecated dsh does not paginate (see the file header); the field is kept for compatibility with passthrough during session/index.ts dispatch, the builder ignores it. */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// -- ask_user_question input schema (dsh snake_case + required id) ------------------

interface DshAskQuestionOption {
  label: string;
  description: string;
}

interface DshAskQuestion {
  /** The dsh schema hard-requires it, echoed in answer; the proxy generates a stable id (short label of the question). */
  id: string;
  question: string;
  header: string;
  options: DshAskQuestionOption[];
  /** dsh is snake_case, unlike CC's multiSelect camelCase. */
  multi_select: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: DshAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: DshAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: titlePrefix + "Link team assets to this conversation?" + SKIP_HINT,
      header: "Link assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Choose Team / Agent / Task and inject the team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time and pass straight through" },
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // dsh has no cap on options, render everything, no pagination (see the file header comment).
    const teamOpts: DshAskQuestionOption[] = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[dsh form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      id: "team_select",
      question: titlePrefix + "Which Team is this session for?" + SKIP_HINT,
      header: "Team",
      options: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    // dsh has no cap on options, render everything, no pagination.
    const combinedOptions: DshAskQuestionOption[] = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (combinedOptions.length < 2) {
      throw new Error(
        `[dsh form] agent stage requires ≥2 agents (got ${combinedOptions.length}). ` +
          `Caller must handle single-agent auto-select upstream.`,
      );
    }

    questions.push({
      id: "agent_select",
      question: titlePrefix + `Which Agent in "${team.team_name}" should be used?` + SKIP_HINT,
      header: "Agent",
      options: combinedOptions,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    // dsh has no cap on options, render everything, no pagination.
    // team.tasks[0] is the virtual default task ("Skip for now"), unshifted once at the source,
    // and with no pagination it will not appear at the start of every page like the old version (pitfall doc section 6 pitfall #9).
    const taskOpts: DshAskQuestionOption[] = team.tasks.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (taskOpts.length < 2) {
      throw new Error(
        `[dsh form] task stage requires ≥2 tasks (got ${taskOpts.length}). ` +
          `Default task should always be prepended by fetchTeamsAndAgents.`,
      );
    }

    questions.push({
      id: "task_select",
      question: titlePrefix + `Which Task in "${team.team_name}" is this session for?` + SKIP_HINT,
      header: "Task",
      options: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a dsh `ask_user_question` fake form response.
 *
 * Transport: **OpenAI chat/completions** (stream or non-stream).
 * arguments shape: dsh native `{questions: [{id, question, header, options, multi_select}]}`.
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
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
        // deepseek thinking mode strong constraint -- see the REASONING_PLACEHOLDER definition for the full analysis.
        // Key: must be **non-empty**, otherwise the client's translate.ts:133 swallows it under the `reasoning.length > 0`
        // check, and the output-side serialize.ts:99 judges length 0 again -> the upstream body lacks the field -> 400.
        reasoning_content: REASONING_PLACEHOLDER,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: argsStr,
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
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments) + reasoning_content
      // reasoning_content must be **non-empty** (value = REASONING_PLACEHOLDER) -- an empty string is swallowed by
      // dsh translate.ts:133 and not passed back during serialize, giving an upstream 400.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            reasoning_content: REASONING_PLACEHOLDER,
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

      // Chunk 2: arguments delta (whole JSON as single delta)
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

      // Chunk 3: finish
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
