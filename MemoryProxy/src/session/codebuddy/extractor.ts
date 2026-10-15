/**
 * CodeBuddy Session Init — Extractor.
 *
 * Parses the user's reply to the `ask_followup_question` form.
 *
 * -- Why it looks like XML parsing but also works for cross-team multi-round forms --
 *
 * Currently only parses `<question_answer>` XML (CodeBuddy's old format).
 * In practice CodeBuddy actually writes back the `multi_question_result` JSON inside a `role: "tool"` message
 * (see the packet-capture format in the header comment of cleaner.ts), but the extractor's substring fallback matching
 * can "happen" to match a team/agent/task name in unrelated user message text, letting session init succeed by luck.
 * This is a fragile dependency, not exact parsing. For reliable extraction a JSON parsing path would have to be added.
 *
 * Contains no Claude Code logic (does not parse JSON tool_result).
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, PATH_SEP, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const SKIP_RE = /\bskip\b/i;
export const BYPASS_MARKER = "__bypass__" as const;

// -- opencode tool-result unwrapping ---------------------------------------
//
// After opencode CLI's native `question` tool receives the user's choice, it returns the answer to the
// model as plain text in a tool-result, in the format:
//   User has answered your questions: "question description..."="user answer"[, "question 2"="answer 2"]
//
// The **question description often contains words such as "skip" and "do not link"** (because in the form we let the
// user see a "skip" option). If the whole content is fed directly to extractAgentOnly /
// extractTaskOnly, SKIP_RE.test on the first line would hit the "skip" in the question description ->
// misjudged as BYPASS_MARKER, so the agent_select / task_select stage never gets through.
//
// Fix: unwrap first at the entry of these extractors -- extract only the answer segments to the right of every `="..."`
// and concatenate them before subsequent judgments. Non-opencode scenarios (CB XML / codex bare text / wb direct
// answer) do not have this wrapper layer; the helper returns null and the original content old path is used.
//
// The asset_confirm scenario does not use this helper, because extractAssetConfirm is a whitelist-style match of "find the affirmative
// marker first, then the negative marker", and the "skip" wording in the question description is naturally harmless.
//
// Match the value in `="value"` -- note that the value may contain inner quotes escaped by opencode;
// in practice (2026-08-19) when the opencode client meets inner quotes it outputs escaped
// `\"` or passes through full-width quotes as is; for maximum compatibility a simple `[^"]*` match suffices (covering
// all labels in our form.ts -- plain label text has no bare ASCII quotes).
function extractOpencodeAnswers(content: string): string | null {
  if (!content.includes("User has answered your questions:")) return null;
  const answers: string[] = [];
  const re = /"[^"]*"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) answers.push(m[1]);
  }
  return answers.length > 0 ? answers.join(" | ") : null;
}

/**
 * Extract the asset_confirm choice from the user's reply.
 * Returns true=yes (link assets), false=no (bypass), null=not recognized.
 */
export function extractAssetConfirm(content: string): boolean | null {
  // XML parsing
  const xml = parseQuestionAnswerXml(content);
  const answer = xml?.teamAnswer ?? xml?.agentAnswer ?? xml?.taskAnswer ?? content;

  if (answer.includes(ASSET_CONFIRM_YES) || /^\s*(?:yes|confirm)\b/i.test(answer)) {
    return true;
  }
  if (answer.includes(ASSET_CONFIRM_NO) || /^\s*no\b|not this time/i.test(answer)) {
    return false;
  }
  return null;
}

// -- XML parsing ---------------------------------------------------------------

/**
 * Parse CodeBuddy's `<question_answer>` XML from user message.
 */
function parseQuestionAnswerXml(
  content: string,
): {
  teamAnswer?: string;
  agentAnswer?: string;
  taskAnswer?: string;
} | null {
  if (!content.includes("<question_answer") && !content.includes("<question_item")) {
    return null;
  }

  const result: { teamAnswer?: string; agentAnswer?: string; taskAnswer?: string } = {};
  const itemRe =
    /<question_item\s+id="([^"]+)"\s*>[\s\S]*?<answers>\s*([\s\S]*?)\s*<\/answers>/g;

  // First scan all question_items to decide the total (round 1: 1, round 2: 2)
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) { index++; continue; }

    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

// -- Team matching -------------------------------------------------------------

/**
 * Round-1 extraction: identify the selected team_id from the user's reply.
 * CodeBuddy: the user's choice is in the `role: "user"` message, going through `<question_answer>` XML parsing.
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | null {
  if (cachedTeams.length === 0) return null;

  // opencode: unwrap the tool-result wrapper, to keep the "skip" wording in the question description from triggering a false SKIP.
  // See the header comment of extractOpencodeAnswers.
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let teamText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    teamText = xml.teamAnswer ?? null;
  }

  // Matching strategy (team option label format: "team name (last 8 of id)")
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  // Detect "Skip for now" / SKIP_RE -> bypass.
  // (P1-4) Early on SKIP_RE was only tested on the teamText parsed from XML, so non-XML content never reached it;
  // in the real codex CLI codexFormAnswersAsMessages extracts the JSON answer into bare content
  // (such as "skip"), so SKIP_RE never fired -> it fell to ordinary team name matching -> no hit ->
  // the upper layer (init.ts pending_team_select) treated it as "not recognized" and counted attemptCount, forcing bypass only after 3 times
  // maxRetries. Aligned with the stance of extractAgentOnly (line 293) /
  // extractTaskOnly (line 324): test SKIP_RE unconditionally before the formal match.
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

  const exactFull = cachedTeams.find(
    (t) => `${t.team_name} (${t.team_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.team_id;

  const exactName = cachedTeams.find((t) => t.team_name === trimmed);
  if (exactName) return exactName.team_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = cachedTeams.find((t) => t.team_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.team_id;
  }

  const sorted = [...cachedTeams].sort((a, b) => b.team_name.length - a.team_name.length);
  for (const t of sorted) {
    if (hay.includes(t.team_name)) return t.team_id;
  }
  for (const t of cachedTeams) {
    if (hay.includes(t.team_id.slice(-8))) return t.team_id;
  }
  return null;
}

// -- Agent / Task matching -----------------------------------------------------

function matchAgentInTeam(text: string, team: TeamOption): string | null {
  const trimmed = text.trim();

  const exactFull = team.agents.find(
    (a) => `${a.agent_name} (${a.agent_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.agent_id;

  const exactName = team.agents.find((a) => a.agent_name === trimmed);
  if (exactName) return exactName.agent_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.agents.find((a) => a.agent_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.agent_id;
  }

  const sorted = [...team.agents].sort((a, b) => b.agent_name.length - a.agent_name.length);
  for (const a of sorted) {
    if (text.includes(a.agent_name)) return a.agent_id;
  }
  for (const a of team.agents) {
    if (text.includes(a.agent_id.slice(-8))) return a.agent_id;
  }
  return null;
}

function matchTaskInTeam(text: string, team: TeamOption): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }
  return undefined;
}

/**
 * Round-2 extraction: identify agent + task from the user's reply, **strictly limited to the already selected team**.
 * CodeBuddy: goes through `<question_answer>` XML parsing.
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  // opencode: unwrap the tool-result wrapper (see the header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    agentText = xml.agentAnswer ?? null;
    taskText = xml.taskAnswer ?? null;
  }

  // Detect that the Agent chose "Do not link this time" -> bypass
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task. The defaultTaskId fallback is implemented via injection at the head by fetchTeamsAndAgents:
  // when the user picks the "Skip for now" label, matchTaskInTeam hits the virtual entry and returns
  // defaultTaskId, with no separate handling needed here. The SKIP_RE fallback is placed after a match failure, to avoid
  // the virtual entry's "do not link" wording causing a false hit.
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team);
  if (!taskId && SKIP_RE.test(taskHay)) {
    taskId = undefined; // explicitly hand-typed "skip" -> keep undefined (goes through the completeRegistration bypass)
  }

  return { agent_id: agentId, task_id: taskId };
}

// -- codex-only single-question extractors --------------------------------------
//
// 2026-08-08 codex session-init refactor: after splitting pending_agent_task into independent
// pending_agent_select + pending_task_select, each step extracts only one field.
// Reuses the fuzzy matching above in matchAgentInTeam / matchTaskInTeam (including label/name/
// suffix/substring fallbacks), ensuring that raw labels such as "AgentName (xxxxxxxx)"
// passed down by the codex handler can also hit.
//
// The CB client's old path (asking agent+task together in one shot) continues to go through extractFromOptionText and
// does not touch these two new functions.

/**
 * Identify only an agent_id from plain-text answer (codex single agent_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: the user explicitly expressed "skip / do not link"
 *   - agent_id: hit a candidate
 *   - null: not recognized
 */
export function extractAgentOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: unwrap the tool-result wrapper (see the header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // Try to match agent candidates first: the SKIP_HINT_LATER_STAGE description text in the CB codebuddy form
  // contains the word "skip"; testing SKIP_RE first would also falsely BYPASS the user's button choice at the agent_select stage
  // (regression case: content = "...Please choose the Agent to use under [X]: (if you choose the \"skip\" option...) AgentLabel").
  // Aligned with the stance of extractTaskOnly (below): match first, return on a hit, and let SKIP_RE be the fallback on failure.
  // Contract unchanged: codex client free text "skip" -> match fails -> SKIP_RE fallback -> BYPASS_MARKER.
  const matched = matchAgentInTeam(trimmed, team);
  if (matched) return matched;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
}

/**
 * Identify only a task_id from plain-text answer (codex single task_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: the user explicitly expressed "skip / do not link" (the "do not link a task" here is hit by the defaultTaskId
 *     virtual entry in matchTaskInTeam and goes through the task_id-returning branch, rather than reaching the BYPASS branch)
 *   - task_id: hit a candidate
 *   - null: not recognized
 */
export function extractTaskOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: unwrap the tool-result wrapper (see the header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // Try to match real / virtual task entries first (the virtual entry is injected at the head by fetchTeamsAndAgents,
  // and after the label="Skip for now" hit what is returned is defaultTaskId, consistent with the "skip task but keep
  // agent" contract, and not treated as BYPASS).
  const matched = matchTaskInTeam(trimmed, team);
  if (matched) return matched;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
}

// ── Structured / LLM fallback ──────────────────────────────────────────────────

export function extractStructured(content: string): SessionInitData | null {
  const agentMatch = content.match(/agent\s*[:=]\s*(\S+)/i);
  if (!agentMatch) return null;
  const agent_id = agentMatch[1].trim();
  if (!agent_id) return null;

  let task_id: string | undefined;
  const taskMatch = content.match(/task\s*[:=]\s*(\S+)/i);
  if (taskMatch && taskMatch[1] !== "0" && taskMatch[1].toLowerCase() !== "skip") {
    task_id = taskMatch[1].trim();
  }
  return { agent_id, task_id };
}

// ── Resolvers ──────────────────────────────────────────────────────────────────

export function resolveAgent(
  rawAgentId: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

export function resolveTask(
  rawTaskId: string | undefined,
  cachedTeams: TeamOption[],
  agentHintId?: string,
  selectedTeamId?: string,
): string | undefined {
  if (!rawTaskId) return undefined;
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}
