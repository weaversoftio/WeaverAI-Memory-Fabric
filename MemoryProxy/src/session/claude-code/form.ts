/**
 * Claude Code Session Init Form — `AskUserQuestion` tool_use.
 *
 * Claude Code native interactive form:
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` structs, hard limit of 2-4
 *   - Protocol: Anthropic SSE only
 *   - ID prefix: `toolu_cc_session_init_`
 *   - Pagination: 3 agents per page + 1 "More ->" / SKIP slot
 *
 * Contains no CodeBuddy logic.
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "./pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "toolu_cc_session_init_";

export const TEAM_FORM_TITLE = "Session setup — choose a Team";
export const AGENT_TASK_FORM_TITLE = "Session setup — choose Agent and Task";
export const RETRY_FORM_TITLE = "Selection not recognised, please choose again";

export const SKIP_LABEL = "Skip this time (no injection, pass straight through)";
export const MORE_LABEL = "More →";

export const ASSET_CONFIRM_YES = "Yes, link team assets";
export const ASSET_CONFIRM_NO = "No, not this time";
export const ASSET_CONFIRM_FORM_TITLE = "Session setup — link team assets?";

/**
 * General note appended to the end of each step's question.
 * Claude Code's AskUserQuestion gives the user an "Other" input box; replying "skip / skip /
 * do not link" goes through the SKIP_RE bypass; free text that is not recognized becomes unrecognized -> also bypass.
 * The wording is unified across workbuddy/codex/codebuddy/dsh to avoid drift in phrasing between clients.
 */
const SKIP_HINT = ' (Pick the closest option; typing your own answer is not supported yet. If you choose No, no team assets are injected into this session.)';

// Pagination layout all goes through pagination.ts; only its constants are used here.
const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if the given string contains any CC form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_use id belongs to a CC session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /** Claude Code pagination: current agent page number (0-based) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── Claude Code AskUserQuestion input schema ───────────────────────────────────

interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + "Link team assets to this conversation?" + SKIP_HINT,
      header: "Link assets",
      options: [
        { label: ASSET_CONFIRM_YES, description: "Choose Team / Agent / Task and inject the team context" },
        { label: ASSET_CONFIRM_NO, description: "Inject nothing this time and pass straight through" },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: list only real teams. The active "skip" entry exists only at the asset_confirm stage; for later
    // stages, "abnormal / unrecognized" is handled by the init.ts bypass fallback.
    //
    // The caller (init.ts) guarantees teams.length >= 2 -- a single team is auto-selected and skipped,
    // and never reaches the team form. The form builder no longer provides a placeholder fallback.
    // description is left empty -- the label already contains the team name + id suffix, repeating "Team: name"
    // would be just noise.
    //
    // Pagination aligned with agent/task: the first N-1 pages have 3 real + "More ->", the last page takes the rest (<=4).
    // The old implementation hard-truncated with `slice(0, 4)`; when the user had >= 5 teams the later teams silently disappeared with no
    // way to page -- fixed (2026-09-03).
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(teams.length, pageIndex);
    const slice = teams.slice(page.start, page.end);
    const teamOpts: Array<{ label: string; description: string }> = slice.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      teamOpts.push({ label: MORE_LABEL, description: `Show the next batch (${remaining} more Teams)` });
    }

    if (teamOpts.length < 2) {
      throw new Error(
        `[cc form] team page ${pageIndex} has ${teamOpts.length} option(s); ` +
          `team stage requires ≥2 teams — caller must auto-select when teams.length === 1, ` +
          `and pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Which Team is this session for${pageSuffix}?` + SKIP_HINT,
      header: page.totalPages > 1 ? `Team ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_select" or "agent_task" (agent_task = no SKIP on last page)
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    // Keep only the agent's own description (informative); drop the "(N tasks selectable after choosing the agent)" /
    // "(no tasks)" tail -- the user is choosing an agent at this point, and the task-count hint neither affects the decision
    // nor is worth the screen space. If the agent has no custom description, description stays empty and no longer falls back to "Agent: name"
    // (the label already has the name).
    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: `Show the next batch (${remaining} more Agents)` });
    }
    // The last page no longer appends SKIP: active skip is only offered at asset_confirm; for later stages "abnormal / unrecognized"
    // is handled by the init.ts bypass fallback.
    //
    // pagination.ts guarantees at least 2 real items per page (when total > 4; when total <= 4 a single page holds all
    // 4 slots, with no MORE); combinedOptions with < 2 should not arrive here.
    if (combinedOptions.length < 2) {
      throw new Error(
        `[cc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = page.totalPages > 1 ? ` (page ${pageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Which Agent in "${team.team_name}" should be used${pageSuffix}?` + SKIP_HINT,
      header: page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "task_select"
  if (!team) return { questions };

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // description is left empty -- the label already contains the task name + id suffix, "Task: name" would be just noise.
    // Virtual fallback entries (isDefault) get no id suffix; there is only one, so no name ambiguity.
    const taskOpts: Array<{ label: string; description: string }> = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: `Show the next batch (${remaining} more Tasks)`,
      });
    }

    // Same as the agent stage: pagination.ts guarantees count >= 2; < 2 here means the paginator has a bug.
    if (taskOpts.length < 2) {
      throw new Error(
        `[cc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = page.totalPages > 1 ? ` (page ${taskPageIndex + 1}/${page.totalPages})` : "";
    questions.push({
      question: titlePrefix + `Which Task in "${team.team_name}" is this session for${taskPageSuffix}?` + SKIP_HINT,
      header: page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });

    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Claude Code `AskUserQuestion` fake form response.
 * Always Anthropic SSE streaming (Claude Code only speaks Anthropic).
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);

  const encoder = new TextEncoder();
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
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: TOOL_NAME,
          input: {},
        },
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
