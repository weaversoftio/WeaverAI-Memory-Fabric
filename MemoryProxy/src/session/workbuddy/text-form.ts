/**
 * text-form.ts -- text-mode rendering layer for when WorkBuddy has no AskUserQuestion tool.
 *
 * Scenario: the newer WorkBuddy official tools set dropped AskUserQuestion (capability detection already decided
 * `capabilities.askUserQuestion === false`); if we keep sending tool_calls SSE the client accepts it
 * but does not know how to render it -> stuck. Degrade to: use the OpenAI chat.completions **content chunk**
 * stream, rendering the options as markdown for the LLM client to pass through to the user as is.
 *
 * Layout principles:
 *   - **no emoji** (user rule)
 *   - use a `====` main title divider, a `----` hint-area divider, right-aligned numbers, and blank lines to separate blocks
 *   - visual hierarchy relies on pure ASCII, not on markdown rendering
 *
 * Pagination: uses the standalone `computeTextPagination` (10 items per page, no MORE slot).
 * The user pages via the `next / prev` keywords, recognized in the CP3 parsing layer (this file only renders).
 *
 * Transport:
 *   - stream=true  -> SSE, one role chunk + one content chunk + finish + [DONE]
 *   - stream=false → OpenAI chat.completion JSON, choices[0].message.content = markdown
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormData, FormStage } from "./form.js";
import { computeTextPagination, TEXT_PAGE_SIZE } from "./text-pagination.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Main title divider (visually equivalent to the title emoji in card mode). */
const RULE_MAJOR = "================================================";
/** Hint-area divider (visually separates the option list from the action hints). */
const RULE_MINOR = "------------------------------------------------";

/** Titles of the 4 stages (without step numbers; step numbers are appended dynamically). */
const STAGE_TITLES: Record<FormStage, string> = {
  asset_confirm: "Link team assets?",
  team: "Choose a Team",
  agent_select: "Choose an Agent",
  task_select: "Choose a Task",
  agent_task: "Choose Agent and Task", // legacy, rarely used in text mode (WB takes the CC split path)
};

/** Step numbers of the 4 stages (used for the "Step N/4" hint). */
const STAGE_STEP: Record<FormStage, number> = {
  asset_confirm: 1,
  team: 2,
  agent_select: 3,
  task_select: 4,
  agent_task: 3, // legacy
};

/** Total number of steps of each session-init flow (used for the "Step N/4" hint). */
const TOTAL_STEPS = 4;

// The two option labels of asset_confirm -- must be consistent with ASSET_CONFIRM_YES/NO in workbuddy/form.ts:
// the CP3 parsing layer must normalize the user's reply into these two strings, and only after the fake tool_result is injected
// can the CB extractor recognize them. They are re-declared here rather than imported, keeping text-form independent
// and testable; if the constants in form.ts change, the tests fail on both sides as a reminder to sync.
export const TEXT_ASSET_CONFIRM_YES_LABEL = "Yes, link team assets";
export const TEXT_ASSET_CONFIRM_NO_LABEL = "No, not this time";

/**
 * First-line marker in text-mode content, used for identification on echo (if the injector layer later wants to strip the init text
 * it sent in the previous round, it can identify it via this prefix).
 */
export const TEXT_FORM_MARKER = "[Session setup]";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RetryContext {
  /** The user's raw reply from the previous round (used to echo "could not recognize your reply xxx"). */
  userReplyPreview?: string;
  /** Number of attempts so far (1-based, used for the "attempt N" hint). */
  attemptCount?: number;
  /** Remaining attempts (used for the "M more unrecognized replies will skip automatically" hint). */
  attemptsLeft?: number;
}

// ── Renderers per stage ────────────────────────────────────────────────────────

/**
 * Render the markdown text of the asset_confirm stage.
 */
export function renderAssetConfirmText(retry?: RetryContext): string {
  const header = renderHeader("asset_confirm", null, retry);
  const body = [
    "",
    "   1.  Yes, link team assets",
    "   2.  No, not this time",
    "",
    RULE_MINOR,
    "  How to reply: type yes or no",
    "",
  ].join("\n");
  return header + body;
}

/**
 * Render the markdown text of the team stage.
 */
export function renderTeamText(teams: readonly TeamOption[], pageIndex: number, retry?: RetryContext): string {
  const p = computeTextPagination(teams, pageIndex);
  const header = renderHeader("team", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.team_name ?? t.team_id,
    secondary: t.team_id,
  }));
  const footer = renderFooter(p, "team", teams.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * Render the markdown text of the agent_select stage.
 *
 * @param teams          all teams (used to get agents from selectedTeamId)
 * @param selectedTeamId id of the selected team
 * @param pageIndex      current page number
 * @param retry          optional, retry context
 */
export function renderAgentText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const agents: readonly AgentInTeam[] = team?.agents ?? [];
  const p = computeTextPagination(agents, pageIndex);
  const header = renderHeader("agent_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (a) => ({
    primary: a.agent_name ?? a.agent_id,
    secondary: a.agent_id,
    tertiary: a.description,
  }));
  const footer = renderFooter(p, "agent", agents.length);
  return header + "\n" + body + "\n" + footer;
}

/**
 * Render the markdown text of the task_select stage.
 */
export function renderTaskText(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
  pageIndex: number,
  retry?: RetryContext,
): string {
  const team = findTeam(teams, selectedTeamId);
  const tasks: readonly TaskInTeam[] = team?.tasks ?? [];
  const p = computeTextPagination(tasks, pageIndex);
  const header = renderHeader("task_select", p, retry);
  const body = renderOptionList(p.currentPageItems, p.offset, (t) => ({
    primary: t.task_name ?? t.task_id,
    secondary: t.task_id || "(no task-id)",
    tertiary: t.isDefault ? "default task" : undefined,
  }));
  const footer = renderFooter(p, "task", tasks.length);
  return header + "\n" + body + "\n" + footer;
}

// ── Bypass notice ──────────────────────────────────────────────────────────────

/**
 * Fallback hint text after 3 consecutive unrecognized replies (called by CP4).
 */
export function renderBypassNotice(): string {
  return [
    RULE_MAJOR,
    `  ${TEXT_FORM_MARKER} Team assets not linked`,
    RULE_MAJOR,
    "",
    "  Your choice could not be recognised after 3 attempts, so this session",
    "  continues without team assets.",
    "",
    "  To set it up again, send `mem:session-reset`.",
    "",
  ].join("\n");
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

export interface BuildTextFormOptions {
  /** retry context (optional); pass undefined when not retrying. */
  retry?: RetryContext;
}

/**
 * Dispatch to the corresponding render function by formData.stage, and output the full markdown string.
 */
export function renderTextForm(data: FormData, options: BuildTextFormOptions = {}): string {
  const retry = options.retry;
  const pageIndex = data.pageIndex ?? 0;

  switch (data.stage) {
    case "asset_confirm":
      return renderAssetConfirmText(retry);
    case "team":
      return renderTeamText(data.teams, pageIndex, retry);
    case "agent_select":
    case "agent_task": // legacy: also rendered as agent
      return renderAgentText(data.teams, data.selectedTeamId, pageIndex, retry);
    case "task_select":
      return renderTaskText(data.teams, data.selectedTeamId, pageIndex, retry);
    default:
      // Unreachable in practice, but keep a graceful fallback.
      return renderBypassNotice();
  }
}

/**
 * Build the complete HTTP Response (stream or non-stream), stuffing renderTextForm's markdown
 * into the content field of OpenAI chat.completions.
 */
export function buildWorkBuddyTextFormResponse(
  data: FormData,
  options: BuildTextFormOptions = {},
): Response {
  const markdown = renderTextForm(data, options);
  return buildTextContentResponse(markdown, data.modelId, data.stream === true);
}

/**
 * Build the Response for the bypass scenario (the fallback text after 3 retries, used by CP4).
 */
export function buildBypassNoticeResponse(modelId?: string, stream = false): Response {
  return buildTextContentResponse(renderBypassNotice(), modelId, stream);
}

// ── HTTP Response Builders ─────────────────────────────────────────────────────

function buildTextContentResponse(content: string, modelId?: string, stream = false): Response {
  const model = modelId ?? "unknown";
  const created = Math.floor(Date.now() / 1000);
  const id = "wb-session-init-text-" + Date.now();

  if (stream) {
    return buildStreamingContent(id, created, model, content);
  }
  return buildNonStreamingContent(id, created, model, content);
}

function buildNonStreamingContent(id: string, created: number, model: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function buildStreamingContent(id: string, created: number, model: string, content: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 2: content (sent whole at once; no need to split by token, the client only needs to read the complete text)
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      // Chunk 3: finish
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })}\n\n`,
        ),
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface OptionLine {
  primary: string;
  secondary?: string;
  tertiary?: string;
}

/**
 * Render the title block (including the divider + step number + subtitle pagination info / retry info).
 */
function renderHeader(stage: FormStage, pagination: ReturnType<typeof computeTextPagination> | null, retry?: RetryContext): string {
  const step = STAGE_STEP[stage];
  const title = STAGE_TITLES[stage];
  const isRetry = retry !== undefined;

  const lines: string[] = [];
  lines.push(RULE_MAJOR);

  if (isRetry) {
    // Retry title: highlight "could not recognize"
    const preview = truncatePreview(retry?.userReplyPreview);
    lines.push(`  ${TEXT_FORM_MARKER} Could not recognise your reply${preview ? ` "${preview}"` : ""}`);
    if (typeof retry?.attemptCount === "number") {
      const left = retry.attemptsLeft;
      const leftPart = typeof left === "number" && left > 0
        ? `; after ${left} more unrecognised replies, setup is bypassed`
        : "";
      lines.push(`  Attempt ${retry.attemptCount}${leftPart}`);
    }
    lines.push(RULE_MAJOR);
    lines.push("");
    lines.push(`  ${TEXT_FORM_MARKER} Step ${step}/${TOTAL_STEPS}: ${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  Page ${pagination.currentPageIndex + 1} of ${pagination.totalPages}`);
    }
  } else {
    lines.push(`  ${TEXT_FORM_MARKER} Step ${step}/${TOTAL_STEPS}: ${title}`);
    if (pagination && !pagination.isEmpty) {
      lines.push(`  Page ${pagination.currentPageIndex + 1} of ${pagination.totalPages}`);
    }
    lines.push(RULE_MAJOR);
  }

  return lines.join("\n");
}

/**
 * Render the option list. Numbers are right-aligned (1..99 all align).
 *
 * WARNING: explicitly wrap it in a ```plaintext code fence:
 *   our option lines themselves use a "  N.  xxx" prefix (indented 3~4 spaces) -- to a markdown
 *   renderer, lines 1~9 are 4-space indented (triggering an indented-code-block), while lines 10+
 *   have one less indent and fall out of the code block; and the tertiary (description) sub-lines have yet another indent.
 *   The result is that the workbuddy client wraps items 1~9 in a code chip, while items 10+ and the description lines fall out
 *   as bare text (the figure 1 symptom). After proactively wrapping a ```plaintext fence, the whole block renders with fenced
 *   code-block semantics, the number of spaces within lines no longer matters at all, and the look is consistent.
 */
function renderOptionList<T>(
  items: readonly T[],
  offset: number,
  extract: (item: T) => OptionLine,
): string {
  if (items.length === 0) {
    return "\n```plaintext\n  (the list is empty)\n```\n";
  }

  const lines: string[] = ["", "```plaintext"];
  items.forEach((item, i) => {
    const absoluteIdx = offset + i + 1; // 1-based display ordinal
    const line = extract(item);
    const numStr = `${absoluteIdx}.`.padStart(4, " ");
    // Main line: number + main label + ID (separated by " · ")
    const idPart = line.secondary ? `  ·  ${line.secondary}` : "";
    lines.push(`  ${numStr}  ${line.primary}${idPart}`);
    // Sub line: description or label (indent-aligned)
    if (line.tertiary) {
      lines.push(`         ${line.tertiary}`);
    }
  });
  lines.push("```", "");
  return lines.join("\n");
}

/**
 * Render the action hint area (reply-method description + next/prev/skip keywords).
 *
 * Numeric addressing goes by the **1-based ordinal across the whole list** (consistent with absoluteIdx in renderOptionList),
 * so the range hint must use `totalItems` (the whole list length), not `currentPageItems.length`.
 * Example: task_select has 28 items in 3 pages; whatever page the user turns to, the reply hint says "1..28".
 */
function renderFooter(
  pagination: ReturnType<typeof computeTextPagination>,
  _entity: "team" | "agent" | "task",
  totalItems: number,
): string {
  const lines: string[] = [];
  lines.push(RULE_MINOR);
  lines.push("  How to reply:");
  const pageRange = pagination.isEmpty
    ? "(none)"
    : `1..${totalItems}`;
  lines.push(`    - a number (e.g. ${pagination.isEmpty ? "1" : "2"}, range ${pageRange})`);
  if (pagination.hasNext) {
    lines.push("    - next  —— show more");
  }
  if (pagination.hasPrev) {
    lines.push("    - prev  —— previous page");
  }
  lines.push("    - skip  —— continue without team assets");
  lines.push("");
  return lines.join("\n");
}

function findTeam(teams: readonly TeamOption[], selectedTeamId: string | undefined): TeamOption | undefined {
  if (!selectedTeamId) return teams[0];
  return teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
}

function truncatePreview(s?: string, max = 40): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

// ── Re-exports ─────────────────────────────────────────────────────────────────

export { TEXT_PAGE_SIZE };
