/**
 * WorkBuddy Text Mode -- input preprocessor.
 *
 * -- Background ------------------------------------------------------------
 *
 * The newer WorkBuddy official tools set dropped `AskUserQuestion` (confirmed by packet capture: tools
 * number only 20); if we keep sending tool_calls SSE the client does not recognize it -> stuck pending. CP1 detected
 * `capabilities.askUserQuestion === false`, CP2 already renders plain text, and this module
 * is responsible for translating the **next round's user reply**: translating bare text into a form the CB state machine extractor can
 * recognize.
 *
 * -- Design idea (reuse existing CB capabilities) --------------------------
 *
 * The CB extractor already has strong substring matching + SKIP_RE + short-id fallback logic
 * (see codebuddy/extractor.ts). Text-mode user input forms -> translations CB can recognize:
 *
 *   | user input             | translate result                        |
 *   |------------------------|-----------------------------------------|
 *   | "2" (number)           | the 2nd item's team_name/agent_name/... in the whole list |
 *   | "team B" (name/prefix) | passed through as is (CB substring hit)  |
 *   | "abc12345" (short-id)  | passed through as is (CB short-id suffix hit) |
 *   | "next" / "next page"              | "More ->" (triggers the existing WB MORE interception)  |
 *   | "prev" / "previous page"          | special action = "paginate-prev", needs short-circuit   |
 *   | "skip"                            | passed through as is (CB SKIP_RE hit)    |
 *   | "yes" / "no"                      | passed through as is (recognized by the asset_confirm branch)  |
 *   | other                  | passed through as is (the CB extractor falls back to retry)  |
 *
 * -- Numeric addressing: whole list vs current page --------------------
 *
 * Numbers the user types ("1", "14", etc.) address by the **1-based ordinal across the whole list**, not the relative ordinal
 * within the current page. This aligns exactly with the absolute ordinal output by `absoluteIdx = offset + i + 1` in the
 * render layer (`text-form.ts renderOptionList`) -- the number the user visually sees
 * is the whole-list position, and whatever page they have turned to, typing "14" points exactly at the 14th item.
 *
 * Out of range: only a number > the whole-list length counts as out of range -> passthrough; it then goes through the CB extractor's
 * retry / bypass fallback. A number within the whole list but outside the current page's range (e.g. the user types
 * "14" on page 1 while item 14 is on page 2) is still translated to the name of item 14.
 *
 * -- Zero-impact guarantee ------------------------------------------------
 *
 * This module **has no global side effects** -- it is a pure function. The caller (codebuddy/init.ts) uses
 * `capabilities?.askUserQuestion === false` as a strict gate; only requests from the newer WorkBuddy
 * without the AskUserQuestion tool come in. All other clients never enter.
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormStage } from "./form.js";
import { MORE_LABEL as WB_MORE_LABEL, SKIP_LABEL as WB_SKIP_LABEL } from "./form.js";
import { TEXT_PAGE_SIZE } from "./text-pagination.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Preprocessor decision.
 *
 * - `translate`  -> overwrite the content of the last user message at the tail of messages with `translated`,
 *                  then **let it through** to the CB state machine to keep running (the extractor's old path).
 * - `paginate-next` / `paginate-prev` -> **short-circuit**: directly change
 *                     state.codexPageIndex[the corresponding stage] to newPageIndex and
 *                     re-render the form of the same stage. Does not enter the extractor, does not consume
 *                     attemptCount, and does not advance the stage.
 * - `passthrough` -> do nothing; the user's original text goes straight to the extractor (for example forms the extractor can already recognize, such as "skip / team A /
 *                   team-abc12345").
 */
export type PreprocessAction = "translate" | "paginate-next" | "paginate-prev" | "passthrough";

export interface PreprocessResult {
  action: PreprocessAction;
  /** The replaced text when action=translate; undefined otherwise. */
  translated?: string;
  /** The new page number when action=paginate-* (already clamped to the valid range); undefined otherwise. */
  newPageIndex?: number;
  /**
   * Only for logs and debugging, stating which branch the preprocessing took.
   */
  reason: string;
}

/**
 * Context the preprocessor needs: the full teams list, the current stage, the pagination info of the current stage,
 * and the selected team/agent id (used to filter out agent/task candidates).
 */
export interface PreprocessOptions {
  stage: FormStage;
  teams: readonly TeamOption[];
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** Page number of the current stage (0-based). */
  currentPage: number;
  /** Page size. Defaults to TEXT_PAGE_SIZE. */
  pageSize?: number;
}

// -- Keyword regexes ------------------------------------------------------

/** next / next page / next step — triggers MORE paging. */
const NEXT_RE = /^\s*(next|n)\s*$/i;

/** prev / previous page / previous step — triggers paginate-prev. */
const PREV_RE = /^\s*(prev|previous|p)\s*$/i;

/** Pure digits -- need to look up the table by the current page slice and translate into the corresponding label. */
const DIGIT_RE = /^\s*(\d+)\s*$/;

/** yes / y — translated into the ASSET_CONFIRM_YES label only at the asset_confirm stage. */
const YES_RE = /^\s*(yes|y)\s*$/i;

/** no / n — translated into the ASSET_CONFIRM_NO label only at the asset_confirm stage. */
const NO_RE = /^\s*(no|n)\s*$/i;

// -- Main function --------------------------------------------------------

/**
 * Preprocess the user's bare-text reply in text mode.
 *
 * Only WorkBuddy requests with `capabilities?.askUserQuestion === false` call this
 * function (the gate is at the entry of codebuddy/init.ts). **All other clients never enter**.
 *
 * -- Match priority ------------------------------------------------------
 *
 *   1. prev  -> action="paginate-prev" (page number -1, clamped to 0)
 *   2. next  -> action="paginate-next" (page number +1, clamped to totalPages-1)
 *   3. number -> take the Nth item from the **whole list** and translate into team_name/agent_name/task_name
 *              (or the concrete "Yes/No" label of asset_confirm). Only a whole-list out-of-range
 *              passes through; cross-page numbers can still hit.
 *   4. other  -> passthrough (the CB extractor falls back to substring / SKIP_RE)
 *
 * Note: **name / short-id matching is left to the CB extractor** (it already does it well); we only
 * handle "capabilities the CB extractor lacks" (numeric paging / page-level numbers / prev / next).
 */
export function preprocessTextModeInput(
  rawText: string,
  options: PreprocessOptions,
): PreprocessResult {
  // Strip system XML wrappers that the WorkBuddy client may wrap around the text, such as <system-reminder> / <user_query> /
  // <additional_data> / <craft_mode>, keeping only what the user really typed.
  // If the original text has no such wrappers (e.g. an old client or clean input), extractUserQueryText returns it as is.
  const cleaned = extractUserQueryText(rawText ?? "");
  const text = cleaned.trim();
  if (!text) {
    return { action: "passthrough", reason: "empty-input" };
  }

  const pageSize = options.pageSize ?? TEXT_PAGE_SIZE;
  const totalItems = getTotalItemsForStage(options);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  // -- 0. yes/no (asset_confirm stage only) -> translated into the exact label --------
  // Must come before next/prev: `n` hits both NEXT_RE and NO_RE, and at the asset_confirm stage
  // `n` should semantically be "no" rather than "next" (asset_confirm needs no paging either).
  // For yes/no at other stages, passthrough goes to the extractor (the extractor does not recognize them for now and will go through the
  // retry fallback, behaviour unchanged).
  if (options.stage === "asset_confirm") {
    if (YES_RE.test(text)) {
      return {
        action: "translate",
        translated: "Yes, link team assets",
        reason: `yes-keyword → "Yes, link team assets"`,
      };
    }
    if (NO_RE.test(text)) {
      return {
        action: "translate",
        translated: "No, not this time",
        reason: `no-keyword → "No, not this time"`,
      };
    }
  }

  // -- 1. prev (previous page) ---------------------------------------------
  if (PREV_RE.test(text)) {
    const nextPage = Math.max(0, options.currentPage - 1);
    return {
      action: "paginate-prev",
      newPageIndex: nextPage,
      reason: `prev-keyword: ${options.currentPage} → ${nextPage}`,
    };
  }

  // -- 2. next (next page) -> paginate-next short-circuit ------------------
  if (NEXT_RE.test(text)) {
    const nextPage = Math.min(totalPages - 1, options.currentPage + 1);
    return {
      action: "paginate-next",
      newPageIndex: nextPage,
      reason: `next-keyword: ${options.currentPage} → ${nextPage} (total=${totalPages})`,
    };
  }

  // -- 3. number -> look up the Nth item on the current page ---------------
  const digitMatch = text.match(DIGIT_RE);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    const translated = resolveNumberToLabel(n, options);
    if (translated !== null) {
      return {
        action: "translate",
        translated,
        reason: `digit-${n} → "${translated}"`,
      };
    }
    // Number out of range -> passthrough, leave it to the extractor's fallback to go through retry
    return {
      action: "passthrough",
      reason: `digit-${n} out-of-range`,
    };
  }

  // -- 4. other -> passthrough (skip / name / id all land here) -------------
  return {
    action: "passthrough",
    reason: "verbatim (skip/name/short-id/other)",
  };
}

// -- number -> label lookup ----------------------------------------------

/**
 * Map the Nth option (**1-based ordinal across the whole list**) back to a label.
 *
 * - asset_confirm: N=1 -> ASSET_CONFIRM_YES keyword; N=2 -> ASSET_CONFIRM_NO keyword
 *   (passing through the full string directly, such as "Yes, link team assets" / "No, not this time",
 *   is hit exactly by extractAssetConfirm)
 * - team / agent_select / task_select: take the name of the Nth item in the whole list (without the
 *   parenthesized short-id suffix; CB substring matching on the name itself is enough)
 *
 * Numeric addressing is independent of pagination: typing "14" on page 2 also directly hits the 14th item in the whole list,
 * consistent with the absolute ordinal output by the render layer (`absoluteIdx = offset + i + 1`).
 *
 * Returning null means N is out of range (> whole-list length) / the stage is not recognized.
 */
function resolveNumberToLabel(
  n: number,
  options: PreprocessOptions,
): string | null {
  if (n < 1) return null;

  switch (options.stage) {
    case "asset_confirm": {
      // asset_confirm has only 2 fixed options, no pagination. extractAssetConfirm recognizes
      // keywords such as "Yes" / "No" / "link", and returns the exact literal string directly.
      if (n === 1) return "Yes, link team assets";
      if (n === 2) return "No, not this time";
      return null;
    }

    case "team": {
      if (n > options.teams.length) return null;
      const item = options.teams[n - 1] as TeamOption;
      return item.team_name;
    }

    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.agents.length) return null;
      const item = team.agents[n - 1] as AgentInTeam;
      return item.agent_name;
    }

    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.tasks.length) return null;
      const item = team.tasks[n - 1] as TaskInTeam;
      // After the "Skip for now (do not link a task)" virtual entry hits, return its original label so that
      // extractTaskOnly goes through the defaultTaskId virtual-entry matching path; no extra
      // handling needed.
      return item.task_name;
    }

    // The agent_task legacy branch (the CB one-shot old path) is never reached in text mode,
    // because workbuddy is forced onto the split agent_select / task_select.
    default:
      return null;
  }
}

// -- Utility functions ----------------------------------------------------

function findTeam(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
): TeamOption | undefined {
  if (!selectedTeamId) return undefined;
  return teams.find((t) => t.team_id === selectedTeamId);
}

/**
 * Get the total number of candidates for the current stage (used to compute totalPages, only for the next/prev clamp).
 * asset_confirm has only 2 fixed items, always a single page, returns 2.
 * team -> teams.length; agent_select -> team.agents.length; task_select -> team.tasks.length.
 * Team not found -> 0 (totalPages=1, next clamps to 0, i.e. stays in place).
 */
function getTotalItemsForStage(options: PreprocessOptions): number {
  switch (options.stage) {
    case "asset_confirm":
      return 2;
    case "team":
      return options.teams.length;
    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.agents.length ?? 0;
    }
    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.tasks.length ?? 0;
    }
    default:
      return 0;
  }
}

// -- Exported constants (for tests) ----------------------------------------

export const _internals = {
  NEXT_RE,
  PREV_RE,
  DIGIT_RE,
  YES_RE,
  NO_RE,
  WB_MORE_LABEL,
  WB_SKIP_LABEL,
};
