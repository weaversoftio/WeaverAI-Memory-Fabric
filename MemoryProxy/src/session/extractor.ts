/**
 * Identity extractor — picks agent + task selection from user reply.
 *
 * V3: Supports:
 *   1. ask_followup_question option text (user clicked a button) — matched by name
 *   2. Numeric selection ("agent: 1\ntask: 2")
 *   3. Raw ID input ("agent: agent_bug_fixer")
 *
 * The historical LLM-based extraction fallback was removed — when structured
 * parsing can't match, callers should bump the retry counter and bypass.
 */

import type { SessionInitData, AgentOption, TaskOption, TeamOption } from "./types.js";
import { PATH_SEP, SKIP_LABEL, MORE_LABEL } from "./form.js";

// ── Path A: Match from option text (ask_followup_question click result) ────────

const SKIP_RE = /\bskip\b/i;

/** Bypass marker: the user chose "Do not link this time", and the whole session-init is skipped directly. */
export const BYPASS_MARKER = "__bypass__" as const;

/**
 * Pagination "More" marker: in the Claude Code paging flow, when the user clicks "More ->" the handler
 * does agentPageIndex+1 and re-sends the next page form. The status stays pending_agent_task and does not count as a retry.
 */
export const MORE_MARKER = "__more__" as const;

/**
 * Parse CodeBuddy's `<question_answer>` XML that is generated when the user
 * clicks an option in an `ask_followup_question` form. This XML is sent back
 * as the next user message. Example:
 *
 *   <question_answer>
 *   <title>...</title>
 *   <questions>
 *   <question_item id="agent">
 *   <question>Please choose the Agent to use for this session:</question>
 *   <answers>
 *   Bug Fixer -- automatically locates and fixes code defects
 *   </answers>
 *   </question_item>
 *   <question_item id="task">...</question_item>
 *   </questions>
 *   </question_answer>
 *
 * The `id` echoes whatever we passed in the tool_call args (we use "agent"/"task"),
 * but the model may also use generic ids like "q1"/"q2", so we accept both.
 * Returns the raw answer text per slot, or null if no XML form is present.
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
  let m: RegExpExecArray | null;
  let index = 0;
  // First scan all question_items to decide how many questions there are in total.
  // The round-1 form has only 1 question (team), the round-2 form has 2 (agent + task).
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) {
      index++;
      continue;
    }
    // Known ids: team / agent / task; unknown ids fall back to the index
    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        // The round-1 form has only 1 question -- q1 is the team
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        // The round-2 form has 2 questions -- q1 is the agent
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      // Fallback: the first question with an unknown id is assigned to team
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

/**
 * Round-1 extraction: identify the selected team_id from the user's answer.
 *
 * The parsing strategy forks by agentSource:
 * - **CodeBuddy**: the user's choice is in the `role: "user"` message (`<question_answer>` XML or plain text),
 *   going straight to XML parsing + substring fallback. No JSON parsing, to avoid misreading the empty tool shell.
 * - **Claude Code**: the user's choice is in the `role: "tool"` message (`multi_question_result` JSON
 *   or the `AskUserQuestion` tool_result), going through JSON parsing + substring fallback.
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns team_id, or BYPASS_MARKER (the user chose "Do not link this time"), or null (not recognized)
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  agentSource: string = "codebuddy",
): string | null {
  if (cachedTeams.length === 0) return null;

  let teamText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // AskUserQuestion tool_result: { answers: { "q": "label" } }
      if (parsed.answers && typeof parsed.answers === "object") {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          if (typeof val === "string" && val.trim()) {
            teamText = val.trim();
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!teamText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
            let val: string | null = null;
            if (typeof cand === "string") val = cand.trim() || null;
            else if (Array.isArray(cand)) {
              const f = cand.find((x) => typeof x === "string" && x.trim());
              if (typeof f === "string") val = f.trim();
            }
            if (val) { teamText = val; break; }
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!teamText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      teamText = xml.teamAnswer ?? null;
    }
  }

  // Detect "Do not link this time" -> bypass directly (only judged when teamText has been extracted,
  // to avoid "skip / do not link" in the form option text inside content falsely triggering bypass)
  if (teamText && (teamText.includes(SKIP_LABEL) || SKIP_RE.test(teamText.trim()))) {
    return BYPASS_MARKER;
  }

  // Matching strategy (team option label format: "team name (last 8 of id)"):
  //   1. exact match of the full label (with id suffix)
  //   2. exact match of the bare team_name
  //   3. match by the "(xxxxxxxx)" id-suffix part
  //   4. substring fallback (descending by name length)
  const hay = teamText ?? content;
  const trimmed = hay.trim();

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

/**
 * Match an agent within the given team. The round-2 form has already fixed the team, so there is no chance of cross-team false matches.
 *
 * Matching strategy (agent option label format: "agent name (last 8 of id)"):
 *   1. exact match of the full label (with id suffix)
 *   2. exact match of the bare agent_name
 *   3. match by the "(xxxxxxxx)" id-suffix part
 *   4. substring fallback (descending by agent_name length to avoid false matches on short names)
 */
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

/**
 * Match a task within the given team. Task option label format: "task name (last 8 of id)".
 *   - first try an exact match of the full label (with id suffix)
 *   - then try matching task_name only
 *   - substring fallback (descending by name length, preferring long names)
 */
function matchTaskInTeam(
  text: string,
  team: TeamOption,
  _hintAgentId?: string,
): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  // 1) exact match of the full label: "task name (xxxxxxxx)"
  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  // 2) exact match of the bare task_name (there may be several with the same name; return the first)
  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  // 3) exact match by the "(xxxxxxxx)" id-suffix part
  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  // 4) substring fallback: descending by task_name length
  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }

  // 5) loose match: any 8-char substring of trimmed matches the id suffix
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }

  return undefined;
}

/** @deprecated Old flat structure, kept only for old tests to call. */
function matchAgent(text: string, agents: AgentOption[]): string | null {
  const exact = agents.find((a) => a.name === text);
  if (exact) return exact.id;
  const candidates = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of candidates) {
    if (text.includes(a.name)) return a.id;
  }
  return null;
}

/** @deprecated Old flat structure, kept only for old tests to call. */
function matchTask(text: string, tasks: TaskOption[]): string | undefined {
  const exact = tasks.find((t) => t.name === text);
  if (exact) return exact.id;
  const candidates = [...tasks].sort((a, b) => b.name.length - a.name.length);
  for (const t of candidates) {
    if (text.includes(t.name)) return t.id;
  }
  return undefined;
}

/**
 * Round-2 extraction: identify agent + task from the user's answer, **strictly limited to the already selected team**.
 * Cross-team mismatches are ruled out at the protocol layer (the round-1 form has already fixed the team).
 *
 * The parsing strategy forks by agentSource:
 * - **CodeBuddy**: the user's choice is in the `role: "user"` message, going through `<question_answer>` XML parsing
 *   + substring fallback. No JSON parsing, to avoid misreading the empty tool shell.
 * - **Claude Code**: the user's choice is in the `role: "tool"` message (`multi_question_result` JSON
 *   or the `AskUserQuestion` tool_result), going through JSON parsing + substring fallback.
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns `{ agent_id: BYPASS_MARKER }` means the user chose "Do not link this time".
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
  agentSource: string = "codebuddy",
): SessionInitData | null {
  // An already selected team is required to enter round-2 parsing; otherwise it is treated as an illegal state.
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // AskUserQuestion tool_result: { answers: { "q": "label" } }
      if (!agentText && !taskText && parsed.answers && typeof parsed.answers === "object") {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          const trimmed = val.trim();
          if (!trimmed) continue;
          if (matchAgentInTeam(trimmed, team)) {
            agentText = trimmed;
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!agentText && !taskText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          const pickAnswer = (q: Record<string, unknown>): string | null => {
            const cand = q.answer ?? q.answers ?? q.selected ?? q.selectedOption ?? q.value;
            if (cand == null) return null;
            if (typeof cand === "string") return cand.trim() || null;
            if (Array.isArray(cand)) {
              const first = cand.find((x) => typeof x === "string" && x.trim());
              return typeof first === "string" ? first.trim() : null;
            }
            return null;
          };
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
            const ans = pickAnswer(qo);
            if (!ans) continue;
            if (id === "agent" && !agentText) agentText = ans;
            else if (id === "task" && !taskText) taskText = ans;
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!agentText && !taskText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      agentText = xml.agentAnswer ?? null;
      taskText = xml.taskAnswer ?? null;
    }
  }

  // Detect that the Agent chose "More ->" -> flip page (only judged when agentText has been extracted,
  // to avoid labels in the form option text inside content falsely triggering it)
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // Detect that the Agent chose "Do not link this time" -> bypass (same as above, only judged when agentText is explicitly extracted)
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent -- strictly match only within team.agents
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task -- match within the same team; return undefined on an explicit skip
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  if (!SKIP_RE.test(taskHay)) {
    taskId = matchTaskInTeam(taskHay, team, agentId);
  }

  return { agent_id: agentId, task_id: taskId };
}

// ── Path B: Structured Matching ────────────────────────────────────────────────

/** Extract agent_id and optional task from user reply (regex-based). */
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

/**
 * Resolve user's agent selection from a possibly numeric / partial label.
 * A number takes a 1-based index into the selected team's agents; a string is returned as is.
 */
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
  // Parse by 1-based index only when rawAgentId is a **pure number** (an ordinal reply such as "1" / "2").
  // Never use parseInt, which tolerates a leading number -- a ULID starts with "01...", parseInt would get 1,
  // wrongly mapping every real agent_id to team.agents[0] (the team's first agent).
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

/**
 * Resolve user's task selection from a possibly numeric / raw value.
 * A number takes a 1-based index into the task list within the selected team, with agentHintId taking priority; a string is returned as is.
 */
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
  // Same as resolveAgent: accept only pure-number ordinals, so parseInt's tolerance of "01KV..." with a leading "0" does not misjudge.
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}

// ── Combined Interface ─────────────────────────────────────────────────────────

/**
 * Extract identity purely via the engineered structured parser. The historical
 * LLM-based `extractViaLLM` fallback was removed — when structured parsing
 * fails, callers must bump the retry counter and eventually bypass session
 * init rather than hand the guessing job to an LLM.
 */
export async function extractIdentity(
  content: string,
): Promise<SessionInitData | null> {
  return extractStructured(content);
}
