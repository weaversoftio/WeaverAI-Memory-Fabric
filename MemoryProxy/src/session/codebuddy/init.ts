/**
 * CodeBuddy Session Initialization -- state machine entry.
 *
 * Flow:
 *   1. uninitialized -> fetch teams[] from the kernel, send an `ask_followup_question` form
 *   2. pending_team_select -> parse the user's team choice, send the agent_task form
 *   3. pending_agent_task -> parse agent+task, fetch details, register, inject
 *   4. initialized -> strip + inject on every request
 */

import type { SessionInitConfig } from "../../types.js";
import type {
  AgentDetail,
  SessionInitData,
  SessionInitState,
  SessionRegistrationData,
  TaskDetail,
  TaskInTeam,
  TeamOption,
} from "../types.js";
import { DEFAULT_TASK_LABEL } from "../types.js";
import { SessionStore } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import { injectSessionContextWithToggles } from "../context-injector.js";
import type { MetadataClient } from "../../meta/client.js";
import { resolvePresetIdentity, type PresetIdentity } from "../preset.js";

import { buildFormResponse, FormData } from "./form.js";
import { buildBypassNoticeResponse } from "../workbuddy/text-form.js";
import {
  extractFromOptionText,
  extractTeamFromOptionText,
  extractAssetConfirm,
  extractStructured,
  extractAgentOnly,
  extractTaskOnly,
  resolveAgent,
  resolveTask,
  BYPASS_MARKER,
} from "./extractor.js";
import { getLastUserMessageText } from "./cleaner.js";
import { emitSessionInitTelemetryIfCompleted } from "../init-telemetry.js";
import { isDshRuntimeContextSnapshot } from "../../common/user-query-extractor.js";
import {
  CODEX_MORE_LABEL,
  DEFAULT_GATE_PREFIX,
  detectCodexMore,
} from "../codex/form.js";
// WorkBuddy reuses CC's AskUserQuestion form + CC pagination layout (workbuddy/form.ts directly
// imports computePagination + MORE_LABEL="More ->"). The MORE paging interception when WorkBuddy runs on the CB state machine
// must use the same MORE_LABEL check + computePagination out-of-range check, to align with
// the form-side slicing. CC's MORE_LABEL value is exactly the same as in workbuddy/form.ts.
import { MORE_LABEL as WB_MORE_LABEL } from "../claude-code/form.js";
import { computePagination as computeCCPagination } from "../claude-code/pagination.js";
import type { ClientCapabilities } from "../client-capabilities.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionRequestContext {
  stream: boolean;
  modelId: string;
  protocol?: "openai" | "anthropic";
  /**
   * Client capability flags (detected at the handler layer and passed in).
   *
   * Currently the only consumer is the workbuddy branch:
   *   - `askUserQuestion === false` -> no card capability, use text mode (content chunk + plain-text parsing)
   *   - `askUserQuestion === true` / `undefined` -> use the original card mode
   *
   * When unset it is equivalent to `{ askUserQuestion: true }` (aligned with existing behaviour).
   */
  capabilities?: ClientCapabilities;
  /**
   * codex client only: codex's answers do not go through the CB-compatible messages[], but sit in
   * the `function_call_output` items in `body.input[]`. codexHandler has already used
   * `codexFormAnswersAsMessages` to produce a `messages` for the CB state machine to do normal
   * option matching, but the state machine internally also needs the **raw** input[] in order to:
   *   1. detect the Default-mode gate string (the client replays the historical gate output every time)
   *   2. locate precisely by question id whether the MORE hit is on team/agent/task
   *
   * CC / ordinary CB scenarios never pass this field.
   */
  codexAnswerInput?: unknown[];
  /**
   * The CB v1.106+ ask_followup_question schema requires questions to be a real array;
   * old versions expect a JSON string. The handler detects it from body.tools and fills this field,
   * and the form builder decides on that basis whether to JSON.stringify(questions).
   * Defaults to true when unset (aligned with the new version).
   */
  questionsAsArray?: boolean;
}

export interface SessionInitResult {
  intercepted: boolean;
  response?: Response;
  messages?: Record<string, unknown>[];
  sessionInfo?: import("../types.js").SessionInfo | null;
  justRegistered?: boolean;
  agentDetail?: AgentDetail | null;
  taskDetail?: TaskDetail | null;
  /**
   * Display name of the bound team (from cachedTeams[selected].team_name).
   * For display layers such as the mem:session-reset completion confirmation; has a value only when session-init is complete.
   */
  teamName?: string | null;
  /** The user chose "No" (do not link team assets) -> bypass path; all injection hooks should be skipped. */
  bypassed?: boolean;
  /**
   * Reason for bypass (meaningful only when `bypassed === true`). codexHandler uses it to decide
   * whether the first gate hit should return a "Plan mode hint" instead of passing through directly.
   *
   * - "default-gate"  -> the codex client Default mode truncated our request_user_input
   *                     and forged the string "request_user_input is unavailable in Default mode";
   *                     codexHandler should return a Plan mode hint once and then enter the bypass
   *                     steady state.
   * - undefined       -> other bypass paths (the user explicitly chose "No", no-agents, preset
   *                     mismatch, etc.), taking each handler's default bypass behaviour.
   *
   * CC/CB clients themselves cannot trigger default-gate (the client does not forge the gate string); the
   * constant is kept just for cross-handler decisions.
   */
  bypassReason?: "default-gate";
  /**
   * Anthropic-only: pre-built `<session_context>` string the caller must
   * append to `body.system` (the ClaudeCode init module populates this;
   * CodeBuddy stays OpenAI so it is always undefined here). Kept in this
   * interface so `session/index.ts`'s union type stays uniform.
   */
  systemAppend?: string | null;
  /**
   * Raw FormData -- **always** filled when `intercepted === true`.
   *
   * The codex handler uses `session/codex/form.ts::buildFormResponse` to re-render it into
   * the OpenAI Responses API SSE format (`response.output_item.added` +
   * a `function_call` item). CB / CC themselves do not read this field -- `response` is already the complete response
   * under their respective protocols.
   */
  formData?: FormData;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type MessageArr = Record<string, unknown>[];

/**
 * codex-only: decide whether the last function_call_output in `body.input[]` is a
 * client Default-mode gate interception. The client carries the historical gate output every round, so
 * "whether it is the first hit" is judged by the caller via sessionStore.bypassed; here only structural recognition is done.
 *
 * CB/CC clients never send this string, so opt-in detection of the codex-specific scenario in the CB state machine
 * (agentSource==="codex" + reqCtx.codexAnswerInput non-empty) is still safe.
 */
function detectCodexDefaultGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only recognize the case where "the last item of input is the gate output" -- i.e. this round the codex client
  // intercepted the tool_call and directly replayed the gate.
  //
  // Why we must look at the **last item** rather than the "latest function_call_output":
  // the codex client replays the whole history input every round; once a Default-mode gate output appeared in history,
  // it stays in input forever. After the user switches from Default to Plan and resends the command,
  // the client **appends a new user message** at the tail of input (that mem:session-reset
  // or the user's answer to the form), while the old gate output stays in the middle. Scanning the "latest function_call_output"
  // would always hit the old gate, deadlocking on the "please switch to Plan mode" text.
  //
  // Only when the tail is a function_call_output (meaning the client just replayed the gate and has not yet let the user type)
  // is it judged Default; if the tail is a user message / tool_use / other -> the current round is a new turn,
  // ignore the leftover historical gate.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

/**
 * codex-only: decide, from recovered.status + detectCodexMore().perQuestion,
 * which pageIndex (team/agent/task) should be bumped. Returns the bump result and the already-filled
 * new codexPageIndex object; the caller uses them to write state + re-send the form of the same stage.
 *
 * partialMore scenario (agent really chosen, task=more): directly bump the task-side pageIndex by 1
 * and hand it to the CB state machine to keep consuming -- CB will only hit the really chosen agent and advance the big state; the task side relies on
 * the taskPage value of the next stage form to re-pose the question.
 */
function computeCodexPageBumps(
  cur: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
  perQuestion: { team_select: boolean; agent_select: boolean; task_select: boolean },
  fallbackStage: "team" | "agent" | "task" | null,
): { next: { teamPage: number; agentPage: number; taskPage: number }; bumped: Array<"team" | "agent" | "task"> } {
  const teamPage = cur?.teamPage ?? 0;
  const agentPage = cur?.agentPage ?? 0;
  const taskPage = cur?.taskPage ?? 0;
  const bumped: Array<"team" | "agent" | "task"> = [];
  let nextTeam = teamPage;
  let nextAgent = agentPage;
  let nextTask = taskPage;
  if (perQuestion.team_select) { nextTeam++; bumped.push("team"); }
  if (perQuestion.agent_select) { nextAgent++; bumped.push("agent"); }
  if (perQuestion.task_select) { nextTask++; bumped.push("task"); }
  if (bumped.length === 0 && fallbackStage) {
    if (fallbackStage === "team") { nextTeam++; bumped.push("team"); }
    else if (fallbackStage === "agent") { nextAgent++; bumped.push("agent"); }
    else if (fallbackStage === "task") { nextTask++; bumped.push("task"); }
  }
  return { next: { teamPage: nextTeam, agentPage: nextAgent, taskPage: nextTask }, bumped };
}

/**
 * Generate FormData carrying the codex pagination page numbers, for the codex handler to re-render. The CB client
 * ignores these page-number fields (CB `ask_followup_question` does not paginate).
 */
function withCodexPageIndex(
  fd: FormData,
  px: { teamPage?: number; agentPage?: number; taskPage?: number } | undefined,
): FormData {
  if (!px) return fd;
  return {
    ...fd,
    teamPage: px.teamPage ?? 0,
    agentPage: px.agentPage ?? 0,
    taskPage: px.taskPage ?? 0,
  };
}

/**
 * WorkBuddy-only: detect whether the user's answer at a given stage clicked "More ->", and on a hit compute the
 * pageIndex after paging (wrapping back to page 0 when out of range).
 *
 * Background: WorkBuddy (agentSource="workbuddy") reuses the CB state machine to run
 * uninitialized → pending_team_select → pending_agent_select → pending_task_select
 * the whole flow, but form rendering goes through workbuddy/form.ts (AskUserQuestion + CC pagination,
 * MORE_LABEL="More ->"). The CB state machine originally intercepted MORE only in the agentSource="codex" branch
 * (the isCodexSource gate in section B); after WorkBuddy lands in the pending_*_select branch,
 * extractAgentOnly/extractTaskOnly do not recognize "More ->" -> not recognized -> infinitely re-send page 1.
 *
 * Fix: at the entry of each pending_*_select branch, before running the extractor, first use this function to judge
 * MORE. On a hit, bump the page number of the corresponding stage and re-send the same-stage form (the page number is picked from codexPageIndex by stage in the workbuddy
 * re-render branch of session/index.ts,
 * and passed to the pageIndex of workbuddy/form.ts).
 *
 * @param answerText  the user's answer text extracted by getLastUserMessageText(messages)
 * @param currentPage page number of the current stage (0-based)
 * @param total       total candidates of the current stage (agents.length / tasks.length / teams.length)
 * @returns null=not MORE; number=pageIndex after paging (wraps to 0 when out of range)
 */
function detectWorkbuddyMorePage(
  answerText: string,
  currentPage: number,
  total: number,
): number | null {
  if (!answerText.includes(WB_MORE_LABEL)) return null;
  const nextPage = currentPage + 1;
  // Use the same pagination algorithm as the form side to judge out-of-range, to prevent ending on an out-of-range page after paging past the last page and making the form throw the
  // solo-page assertion; aligned with the safeNextPage wraparound logic of claude-code/init.ts.
  const totalPages = computeCCPagination(Math.max(0, total), 0).totalPages;
  return nextPage > totalPages - 1 ? 0 : nextPage;
}

/** Decide whether it is a "brand-new" CodeBuddy / dsh conversation (at most one real user input, no assistant/tool).
 *
 * dsh (deepseek-harness)'s first-frame body stuffs in 3 role=user metadata entries that are **not user input**:
 *   - <system-reminder> workspace instructions
 *   - "Current runtime context." snapshot
 *   - <system-reminder>\nA skill is a reusable... the <available_skills> list
 * Counting them as is would misjudge dsh's first frame as "not brand-new" -> the upper-layer safety-net skips session-init.
 * Here, when counting, user messages carrying the dsh metadata signature (str content starting with a known anchor) are skipped.
 * See MemoryProxy/docs/dsh-recon/2026-08-14-dsh-capture-analysis.md section 2.3.
 */
function isFreshCBConversation(messages: MessageArr): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = (m.role as string) ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role !== "user") continue;
    // dsh metadata user messages do not count as real user input
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") {
      if (
        c.startsWith("<system-reminder>") ||
        isDshRuntimeContextSnapshot(c)
      ) {
        continue;
      }
    }
    userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}

async function fetchTeamsAndAgents(
  userId: string,
  config: SessionInitConfig,
  metadataClient: MetadataClient,
): Promise<{ teams: TeamOption[] }> {
  const teamsRaw = await metadataClient.listTeams(userId);
  const teams: TeamOption[] = [];

  // Parallel fan-out: for each team, fetch agents & tasks concurrently
  const teamResults = await Promise.all(
    teamsRaw.map(async (t) => {
      const [agentsRaw, tasksRaw] = await Promise.all([
        // Agents are scoped to (team, owner) — each user only sees the agents
        // they created within the team. Tasks remain team-wide (unchanged).
        metadataClient.listAgents(t.team_id, userId),
        metadataClient.listTasks(t.team_id),
      ]);
      const tasks: TaskInTeam[] = tasksRaw.map((tk) => ({
        task_id: tk.task_id,
        task_name: tk.title,
      }));
      // See the same comment of fetchTeamsAndAgents in claude-code/init.ts: defaultTaskId
      // is unshifted at the source to the head of the tasks list, and downstream form/extractor go through the existing path.
      if (config.defaultTaskId) {
        tasks.unshift({
          task_id: config.defaultTaskId,
          task_name: DEFAULT_TASK_LABEL,
          isDefault: true,
        });
      }
      return {
        team_id: t.team_id,
        team_name: t.name,
        agents: agentsRaw.map((a) => ({
          agent_id: a.agent_id,
          agent_name: a.name,
          description: a.description ?? undefined,
        })),
        tasks,
      };
    }),
  );
  teams.push(...teamResults);
  return { teams };
}

function findTeamIdForAgent(teams: TeamOption[], agentId: string): string | undefined {
  for (const team of teams) {
    if (team.agents.some((a) => a.agent_id === agentId)) return team.team_id;
  }
  return undefined;
}

/**
 * Assemble the registration payload for a resolved (agent, task). Returns
 * `null` when the agent cannot be matched to any team in the cached list —
 * the caller must bypass session init in that case (there is no
 * `defaultTeamId` fallback any more).
 */
function buildRegistrationData(
  extracted: SessionInitData,
  cachedTeams: TeamOption[],
  sessionId: string,
  userId: string,
): SessionRegistrationData | null {
  const teamId = findTeamIdForAgent(cachedTeams, extracted.agent_id);
  if (!teamId) return null;
  return {
    team_id: teamId,
    user_id: userId,
    agent_id: extracted.agent_id,
    task_id: extracted.task_id,
    session_id: sessionId,
  };
}

function applyArtifactsAndContext(
  messages: MessageArr,
  agentDetail: AgentDetail | null | undefined,
  taskDetail: TaskDetail | null | undefined,
  sessionKey: string,
  config: SessionInitConfig,
): MessageArr {
  // This used to decide whether to stripInitArtifacts based on config.keepInitArtifacts,
  // now the session_init form interaction is **always kept**, with no deletion.
  const injected = injectSessionContextWithToggles(messages, agentDetail, taskDetail, config, sessionKey);
  if (injected !== messages) {
    const finalRoles = (injected as unknown[]).map((m: any) => m.role);
    console.log(
      `[session-init:cb] session=${sessionKey} processed: ${messages.length} msgs, ` +
        `ctx=${agentDetail ? "Y" : "N"}/${taskDetail ? "Y" : "N"} final=[${finalRoles.join(",")}]`,
    );
  }
  return injected as MessageArr;
}

/**
 * Register a session given a resolved agent(+task), fetch details, inject context.
 * Shared by the interactive form path (Case 2) and the header pre-selection path.
 */
export async function completeRegistration(
  resolved: SessionInitData,
  state: SessionInitState,
  cachedTeams: TeamOption[],
  compositeKey: string,
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  messages: MessageArr,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
): Promise<SessionInitResult> {
  const regUserId = (state as any).userId || userId;
  if (!regUserId) {
    console.warn(
      `[session-init:cb] session=${compositeKey} no user_id available → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }
  // task_id is OPTIONAL for registration: the kernel treats task as an
  // optional business dimension (isolation.ts), so a header-identity agent
  // with team+agent but no task (or a stale task) still registers and gets
  // memory — recall just broadens across the agent's memories instead of
  // narrowing to a task. The interactive "Skip for now" / defaultTaskId path
  // also lands here with task_id = defaultTaskId (a virtual value). Do NOT
  // bypass when task_id is missing/undefined.
  const regData = buildRegistrationData(resolved, cachedTeams, sessionKey, regUserId);
  if (!regData) {
    console.warn(
      `[session-init:cb] session=${compositeKey} agent=${resolved.agent_id} not bound to any team → bypass`,
    );
    await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
    return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
  }

  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;

  if (metadataClient) {
    // When task_id is the defaultTaskId (a virtual value), skip getTask -- the task does not exist in the kernel.
    const shouldFetchTask = regData.task_id && regData.task_id !== config.defaultTaskId;
    const [agentRes, taskRes] = await Promise.allSettled([
      metadataClient.getAgent(resolved.agent_id).then((a) => ({
        id: a.agent_id,
        name: a.name,
        description: a.description ?? undefined,
        prompt: a.prompt ?? undefined,
      })),
      shouldFetchTask
        ? metadataClient.getTask(regData.task_id!).then((t) => ({
            id: t.task_id,
            name: t.title,
            description: t.description ?? undefined,
          }))
        : Promise.resolve(null),
    ]);
    if (agentRes.status === "fulfilled") agentDetail = agentRes.value;
    else console.warn(`[session-init:cb] getAgent failed: ${String(agentRes.reason)}`);
    if (taskRes.status === "fulfilled") taskDetail = taskRes.value;
    else console.warn(`[session-init:cb] getTask failed: ${String(taskRes.reason)}`);
  }

  const sessionInfo = buildSessionInfo(regData, userKey, spaceId);
  console.log(
    `[session-init:cb] session=${compositeKey} → initialized ` +
      `agent=${resolved.agent_id} task=${regData.task_id ?? "-"} team=${regData.team_id} user=${sessionInfo.user_id}`,
  );

  // Fire-and-forget: record the participation log (aligned with the claude-code branch, with the source marked as codebuddy).
  // The bypass scenario has already returned above and is naturally filtered out; on failure only warn, never blocking injection.
  // WARNING: task_id === defaultTaskId is the "Skip for now" virtual value, not a task that really exists in the kernel;
  //    reporting it directly would trigger a `task_not_found: task not found: default` 404, so skip.
  if (
    metadataClient &&
    typeof metadataClient.appendParticipationLog === "function" &&
    regData.task_id &&
    regData.task_id !== config.defaultTaskId
  ) {
    metadataClient
      .appendParticipationLog({
        team_id: regData.team_id,
        task_id: regData.task_id,
        agent_id: regData.agent_id,
        user_id: regData.user_id,
        source: "context_proxy:codebuddy",
      })
      .catch((err: unknown) => {
        console.warn(
          `[session-init:cb] participation-log append failed for session=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // Look up the display name of the selected team from cachedTeams, for display layers such as the mem:session-reset
  // completion confirmation to assemble `Team: {name} ({shortId})`. Return null if not found.
  const selectedTeam = (state.cachedTeams ?? cachedTeams).find(
    (t) => t.team_id === regData.team_id,
  );
  const teamName = selectedTeam?.team_name ?? null;

  const nextState: SessionInitState = {
    status: "initialized",
    keyId: sessionKey,
    startedAt: state.startedAt,
    attemptCount: state.attemptCount,
    sessionInfo,
    userId: regUserId,
    cachedTeams: state.cachedTeams ?? cachedTeams,
    selectedTeamId: state.selectedTeamId,
    agentDetail,
    taskDetail,
    resetFlow: state.resetFlow,
    resetEpoch: state.resetEpoch,
  };
  await store.set(compositeKey, nextState);

  const out = applyArtifactsAndContext(messages, agentDetail, taskDetail, compositeKey, config);
  return {
    intercepted: false,
    messages: out,
    sessionInfo,
    justRegistered: true,
    agentDetail,
    taskDetail,
    teamName,
    resetFlow: state.resetFlow ?? false,
  };
}

// ── Main Handler ───────────────────────────────────────────────────────────────

/**
 * Top-level entry wrapper: decorates handleSessionInitInner, emitting one telemetry entry after completion
 * (only when prev !== initialized && after === initialized).
 *
 * The telemetry decoration never changes the state machine; failures / exceptions are silent, with zero awareness in the business path.
 * See docs/design/2026-08-03-internal-usage-telemetry-plan.md section 7.2.
 */
export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const prevStatus = store.get(compositeKey)?.status ?? "uninitialized";
  try {
    const result = await handleSessionInitInner(
      sessionKey, userId, messages, config, store, reqCtx,
      metadataClient, userKey, spaceId, presetIdentity, agentSource,
    );
    // codex-only post-enhancement: put the codexPageIndex of the latest state into formData,
    // so that codexHandler's buildCodexFormResponse gets the correct paging page numbers. This way all
    // `return { intercepted: true }` sites inside handleSessionInitInner
    // need not be changed one by one. The CB client ignores these fields.
    if (agentSource === "codex" && result.intercepted && result.formData) {
      const latest = store.get(compositeKey);
      if (latest?.codexPageIndex) {
        result.formData = withCodexPageIndex(result.formData, latest.codexPageIndex);
      }
    }
    return result;
  } finally {
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource,
    });
  }
}

async function handleSessionInitInner(
  sessionKey: string,
  userId: string | null,
  messages: MessageArr,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
  agentSource: string = "codebuddy",
): Promise<SessionInitResult> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  if (sessionKey === "unknown" || !sessionKey) return { intercepted: false };

  const state = store.get(compositeKey);

  // -- codex-only pre-checks: Default gate + MORE pagination -----------------
  //
  // Both kinds of recognition can never be hit by CB/CC clients (DEFAULT_GATE_PREFIX / CODEX_MORE_LABEL
  // are codex-client-specific strings), so they are enabled only when opting in to the codex source + having a raw input;
  // old CB users have zero regression.
  //
  // isCodexClient (agentSource === "codex") is the master gate for the "stage split":
  //   - as long as it is a codex client, session-init goes through the two-step pending_agent_select ->
  //     pending_task_select, and no longer lands on the old pending_agent_task.
  //   - the CB client's pending_agent_task path of asking both at once stays completely untouched.
  // The codexInput check is placed inside the pre-checks, because gate/MORE recognition is only done when
  // "the current request also carries an answer"; an empty-input first frame does not need it, but still follows the subsequent stage split with codex semantics.
  const codexInput = reqCtx.codexAnswerInput;
  const isCodexClient = agentSource === "codex";
  const isCodexSource = isCodexClient && Array.isArray(codexInput);

  // A. Default-mode gate -- the codex client intercepted request_user_input and filled back the
  //    string "request_user_input is unavailable in Default mode". On the first hit,
  //    persist a bypass state + attach bypassReason, letting codexHandler return a Plan mode
  //    hint once; subsequent requests of the same session pass straight through (state.bypassed=true is already
  //    covered by the Case 3 branch).
  if (isCodexSource && detectCodexDefaultGate(codexInput)) {
    const alreadyBypassed = state?.bypassed === true;
    if (!alreadyBypassed) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state?.startedAt ?? Date.now(),
        attemptCount: state?.attemptCount ?? 0,
        userId: state?.userId ?? (userId ?? undefined),
        cachedTeams: state?.cachedTeams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(
        `[session-init:cb] session=${compositeKey} codex Default gate → bypass (first hit, notify)`,
      );
      return {
        intercepted: false,
        bypassed: true,
        justRegistered: true,
        bypassReason: "default-gate",
        // If the codex Default gate triggers from mem:session-reset, resetFlow is passed through from the old state
        // for codexHandler to swap in targeted text such as "the reset command needs Plan mode".
        resetFlow: state?.resetFlow ?? false,
      };
    }
    // Already bypassed: fall through, Case 3 will take the passthrough branch
  }

  // B. MORE paging -- the user clicked the "More..." option. The CB state machine recognizes and advances / pages by itself,
  //    rather than letting codexHandler intercept independently. Decision order: first look at whether there is a real answer (partial vs
  //    full MORE), intercept the whole request only on fullMore; partialMore lets the real answer advance the
  //    big state, and the MORE side automatically carries a new pageIndex in the next stage's form after advancing.
  if (
    isCodexSource &&
    state &&
    state.status !== "initialized" &&
    state.status !== "uninitialized"
  ) {
    const detection = detectCodexMore(codexInput);
    if (detection.hasMore) {
      // Use the text produced by codexFormAnswersAsMessages to judge "whether it contains a non-MORE real answer"
      const answerText = getLastUserMessageText(messages);
      const stripped = answerText.split(CODEX_MORE_LABEL).join("").trim();
      const hasRealAnswer = stripped.length > 0;
      const partialMore = hasRealAnswer && (
        !detection.perQuestion.team_select ||
        !detection.perQuestion.agent_select ||
        !detection.perQuestion.task_select
      );
      // fallbackStage: for a plain-string MORE, infer back from state.status
      const fallbackStage: "team" | "agent" | "task" | null =
        detection.perQuestion.team_select || detection.perQuestion.agent_select || detection.perQuestion.task_select
          ? null
          : state.status === "pending_team_select"
            ? "team"
            : state.status === "pending_agent_task" || state.status === "pending_agent_select"
              ? "agent"
              : state.status === "pending_task_select"
                ? "task"
                : null;

      const { next, bumped } = computeCodexPageBumps(state.codexPageIndex, detection.perQuestion, fallbackStage);

      if (bumped.length > 0) {
        await store.set(compositeKey, { ...state, codexPageIndex: next });
        console.log(
          `[session-init:cb] session=${compositeKey} codex MORE (${bumped.join(",")}, ${partialMore ? "partial" : "full"}) → ` +
            `teamPage=${next.teamPage} agentPage=${next.agentPage} taskPage=${next.taskPage}`,
        );

        // Full MORE (no real answer) -> intercept the whole request, return the new page form of the current stage.
        // Partial MORE (real answer + MORE) -> persist pageIndex but keep going through the CB state machine
        // to consume the real answer; the MORE side relies on the taskPage/agentPage value of the next stage form to re-pose the question.
        if (!partialMore) {
          const cachedTeams = state.cachedTeams ?? [];
          // Stage is inferred back from the current state.status. After the split every pending_* maps to
          // its own independent stage, and what is returned to the codex form is only that stage's question.
          let stage: FormData["stage"];
          if (state.status === "pending_team_select") stage = "team";
          else if (state.status === "pending_agent_select") stage = "agent_select";
          else if (state.status === "pending_task_select") stage = "task_select";
          else stage = "agent_task"; // legacy pending_agent_task (CB one-shot)
          const fd: FormData = withCodexPageIndex({
            teams: cachedTeams,
            stage,
            selectedTeamId: state.selectedTeamId,
            selectedAgentId: state.selectedAgentId,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          }, next);
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // partial fall through to state-machine dispatch
      }
    }
  }

  // [session-reset] gate removed: always init on missing state

  // ── DEBUG BYPASS ─────────────────────────────────────────────────────
  // When the sessionInit.debugForceIdentity triple is complete and the state is not yet initialized,
  // complete registration directly with the forced identity, skipping listTeams / form rendering. Suitable for local / E2E testing,
  // with no dependence on the kernel-side team/agent list interfaces.
  // Takes effect uniformly for all agentSource (codebuddy/workbuddy/codex).
  if (
    config.debugForceIdentity &&
    userId &&
    metadataClient &&
    (!state || state.status !== "initialized")
  ) {
    const forced = config.debugForceIdentity;
    console.log(
      `[session-init:cb] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forced.team_id} agent=${forced.agent_id} task=${forced.task_id ?? "-"} user=${userId}`,
    );
    const forcedTeams: TeamOption[] = [
      {
        team_id: forced.team_id,
        team_name: forced.team_id,
        agents: [
          { agent_id: forced.agent_id, agent_name: forced.agent_id } as any,
        ],
        tasks: forced.task_id
          ? [{ task_id: forced.task_id, task_name: forced.task_id } as any]
          : [],
      } as TeamOption,
    ];
    const seededState: SessionInitState = (state ?? {
      status: "uninitialized",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
    }) as SessionInitState;
    return await completeRegistration(
      { agent_id: forced.agent_id, task_id: forced.task_id } as any,
      seededState,
      forcedTeams,
      compositeKey,
      sessionKey,
      userId,
      config,
      store,
      messages,
      metadataClient,
      userKey,
      spaceId,
    );
  }

  // -- Case 1: Uninitialized -> first pop the asset_confirm dialog -------------
  if (!state || state.status === "uninitialized") {
    if (!userId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no userId, passing through unintercepted`,
      );
      return { intercepted: false };
    }
    if (!metadataClient) {
      console.warn(
        `[session-init:cb] session=${compositeKey} no metadataClient, passing through unintercepted`,
      );
      return { intercepted: false };
    }

    let teams: TeamOption[];
    try {
      const cfg = await fetchTeamsAndAgents(userId, config, metadataClient);
      teams = cfg.teams;
    } catch (err) {
      console.warn(
        `[session-init:cb] session=${compositeKey} kernel unavailable for user=${userId}, passing through unintercepted: ${err instanceof Error ? err.message : String(err)}`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const totalAgents = teams.reduce((acc, t) => acc + t.agents.length, 0);
    if (totalAgents === 0) {
      console.warn(
        `[session-init:cb] session=${compositeKey} user=${userId} has no active agents, passing through`,
      );
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    // ── Header-driven pre-selection: skip forms when identity is provided ──
    if (presetIdentity && config.headerAutoSelect?.enabled) {
      const pr = resolvePresetIdentity(teams, presetIdentity);

      if (pr.hadMismatch) {
        if (config.headerAutoSelect.onMismatch === "bypass") {
          console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → bypass`);
          await store.set(compositeKey, {
            status: "initialized",
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            sessionInfo: null,
            agentDetail: null,
            taskDetail: null,
            bypassed: true,
          } as SessionInitState);
          return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
        }
        console.warn(`[session-init:cb] session=${compositeKey} preset mismatch → fallback to form`);
        // fall through to the normal asset_confirm flow below
      } else if (pr.canRegister) {
        // team + agent resolved → register directly (task optional). A missing
        // task_id yields undefined → broad recall across the agent's memories;
        // a stale (unknown) task_id was already dropped by resolvePresetIdentity
        // (not echoed back) — warn so the operator can re-point the client.
        if (presetIdentity?.taskId && !pr.taskId) {
          console.warn(
            `[session-init:cb] session=${compositeKey} preset task_id="${presetIdentity.taskId}" not found in team=${pr.teamId} → registering without a task (broad recall)`,
          );
        }
        console.log(
          `[session-init:cb] session=${compositeKey} preset hit team=${pr.teamId} agent=${pr.agentId} task=${pr.taskId ?? "-"} → register directly`,
        );
        const seedState: SessionInitState = {
          status: "uninitialized",
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        };
        return completeRegistration(
          { agent_id: pr.agentId!, task_id: pr.taskId },
          seedState, teams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      } else if (pr.teamId) {
        // only team resolved → jump straight to agent+task selection (skip
        // asset_confirm + team_select). codex/WB/dsh/opencode go through the two-step stage split, agent_select first;
        // the CB client keeps the old pending_agent_task semantics of asking both at once.
        //
        // opencode note: the opencode client's native `question` tool can pop only one question at a time,
        // and cannot carry the "ask agent+task simultaneously" semantics, so it must split stages (same as codex/wb/dsh).
        const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: pr.teamId,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} preset team=${pr.teamId} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: pr.teamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    // -- skipAssetConfirm: skip the asset_confirm dialog, treat it as the user choosing "Yes" ---
    if (config.skipAssetConfirm) {
      console.log(
        `[session-init:cb] session=${compositeKey} skipAssetConfirm=true → skip asset_confirm (teams=${teams.length})`,
      );
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // Progressive auto-select: reuse the 1-team cascade logic of choice===true
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            startedAt: Date.now(),
            attemptCount: 0,
            userId,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} skipAssetConfirm only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: onlyTeam.tasks[0].task_id },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // ≥2 tasks
          await store.set(compositeKey, { ...nextState, status: "pending_task_select" });
          const fd: FormData = {
            teams, stage: "task_select",
            selectedTeamId: onlyTeam.team_id, selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId, protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }
        // ≥2 agents
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: Date.now(),
          attemptCount: 0,
          userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        const fd: FormData = {
          teams, stage: nextStage, selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId, protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
      // >= 2 teams -> pop the team_select form
      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: Date.now(),
        attemptCount: 0,
        userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams, stage: "team",
        stream: reqCtx.stream, questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId, protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // First pop the asset_confirm dialog
    await store.set(compositeKey, {
      status: "pending_asset_confirm",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
    });
    console.log(
      `[session-init:cb] session=${compositeKey} user=${userId} → pending_asset_confirm (teams=${teams.length})`,
    );
    const fd: FormData = {
      teams,
      stage: "asset_confirm",
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // -- CP3 . WorkBuddy text-mode preprocessing (strict gate) --------------------
  //
  // Entered only when `capabilities?.askUserQuestion === false` (i.e. CP1 detected that workbuddy's
  // official tools have no AskUserQuestion). The existing behaviour of all other clients, and of
  // capabilities === undefined, is **unchanged by a single line**.
  //
  // The preprocessing does four things (see workbuddy/text-preprocess.ts for details):
  //   1. user types "prev / previous page" -> paginate-prev short-circuit: change codexPageIndex[stage]
  //                                and then return formData (the session/index.ts layer will
  //                                re-render the same-stage form with buildWorkBuddyTextFormResponse
  //                                according to capabilities)
  //   2. user types "next / next page"   -> paginate-next short-circuit (same as above, page number +1, clamped)
  //   3. user types a number N             -> translate: replace the content of the tail user message in messages with
  //                                the current page's Nth team_name / agent_name / task_name
  //                                / "Yes, link team assets" / "No, not this time"
  //   4. other (skip / name / short-id / gibberish) -> passthrough, left to the CB extractor as the fallback
  //
  // In the translate case, **the original messages array is not mutated** -- deep-copy the tail user message,
  // replace its content, then reassign to the local `messages`. The original body.messages is not polluted at all.
  //
  // In the paginate-* case, **short-circuit return** -- same stance as the MORE interception of codex/workbuddy:
  // change state.codexPageIndex[stage] and return `{ intercepted: true, formData }`,
  // which the workbuddy dispatch point of session/index.ts takes over to re-render with text-form.
  if (
    reqCtx.capabilities?.askUserQuestion === false &&
    isTextModePendingSelectStage(state.status)
  ) {
    const stageForPreprocess = statusToTextModeStage(state.status);
    if (stageForPreprocess) {
      const { preprocessTextModeInput } = await import(
        "../workbuddy/text-preprocess.js"
      );
      const currentPage = readCurrentPageForStage(state, stageForPreprocess);
      const rawUserText = getLastUserMessageText(messages);
      const preResult = preprocessTextModeInput(rawUserText, {
        stage: stageForPreprocess,
        teams: state.cachedTeams ?? [],
        selectedTeamId: state.selectedTeamId,
        selectedAgentId: state.selectedAgentId,
        currentPage,
      });

      if (config.debugVerboseLogging) {
        console.log(
          `[session-init:text-mode] session=${compositeKey} stage=${stageForPreprocess} ` +
            `input=${JSON.stringify(rawUserText).slice(0, 100)} → action=${preResult.action} ` +
            `reason=${preResult.reason}`,
        );
      }

      // -- short-circuit branch: paginate-next / paginate-prev -----------------
      if (
        (preResult.action === "paginate-next" ||
          preResult.action === "paginate-prev") &&
        preResult.newPageIndex !== undefined
      ) {
        const newState = writeCurrentPageForStage(
          state,
          stageForPreprocess,
          preResult.newPageIndex,
        );
        await store.set(compositeKey, newState);
        // Assemble formData (does not consume attemptCount / does not advance the stage). The workbuddy dispatch
        // of the session/index.ts layer will, according to capabilities.askUserQuestion=false, pick
        // the text-form re-render, outputting a content chunk SSE.
        const fd = buildFormDataForTextModeStage(newState, stageForPreprocess, reqCtx);
        return { intercepted: true, formData: fd };
      }

      // -- translate branch: replace the content of the tail user message in messages ----
      if (preResult.action === "translate" && preResult.translated !== undefined) {
        messages = replaceLastUserMessageContentImmutable(messages, preResult.translated);
      }
      // passthrough: do nothing
    }
  }

  // ── Case 1.25: Awaiting asset_confirm ────────────────────────────────────
  if (state.status === "pending_asset_confirm") {
    const lastUserText = getLastUserMessageText(messages);
    const choice = extractAssetConfirm(lastUserText);
    if (config.debugVerboseLogging) {
      console.log(
        `[session-init:cb-debug] asset_confirm session=${compositeKey} choice=${choice} lastUserText=${JSON.stringify(lastUserText).slice(0, 300)}`,
      );
    }

    if (choice === false) {
      // bypass: the user explicitly chose "do not link" -- keep the form dialogue as is, do not delete.
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: state.attemptCount,
        userId: state.userId,
        cachedTeams: state.cachedTeams,
        selectedTeamId: undefined,
        agentDetail: null,
        taskDetail: null,
        sessionInfo: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} user chose no-asset → bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (choice === true) {
      const teams = state.cachedTeams ?? [];
      if (teams.length === 1) {
        const onlyTeam = teams[0];
        // Progressive auto-select: when team=1, if there is also only 1 agent, skip the agent form directly;
        // if there is only 1 task, auto-select further, avoiding the solo-page assertion in the form.
        // This chain is common to CB / WB / codex (the CB old path originally asked both in agent_task
        // at once, but it should likewise be skipped when there is only 1 agent).
        if (onlyTeam.agents.length === 1) {
          const soloAgent = onlyTeam.agents[0];
          const nextState: SessionInitState = {
            ...state,
            status: "pending_agent_select" as any,
            keyId: sessionKey,
            attemptCount: 0,
            cachedTeams: teams,
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
          };
          console.log(
            `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} only-agent=${soloAgent.agent_id} auto-select`,
          );
          // 0 tasks -> bypass; 1 task -> completeRegistration directly; >= 2 -> output the task form.
          if (onlyTeam.tasks.length === 0) {
            await store.set(compositeKey, {
              ...nextState,
              status: "initialized",
              sessionInfo: null,
              agentDetail: null,
              taskDetail: null,
              bypassed: true,
            } as SessionInitState);
            console.log(
              `[session-init:cb] session=${compositeKey} team has 0 tasks → bypass`,
            );
            return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
          }
          if (onlyTeam.tasks.length === 1) {
            const soleTaskId = onlyTeam.tasks[0].task_id;
            console.log(
              `[session-init:cb] session=${compositeKey} auto-select single task=${soleTaskId} → completeRegistration`,
            );
            return await completeRegistration(
              { agent_id: soloAgent.agent_id, task_id: soleTaskId },
              nextState, teams, compositeKey, sessionKey, userId,
              config, store, messages, metadataClient, userKey, spaceId,
            );
          }
          // >= 2 tasks: switch to the task_select stage to output the task form.
          await store.set(compositeKey, {
            ...nextState,
            status: "pending_task_select",
          });
          console.log(
            `[session-init:cb] session=${compositeKey} → pending_task_select (tasks=${onlyTeam.tasks.length})`,
          );
          const fd: FormData = {
            teams,
            stage: "task_select",
            selectedTeamId: onlyTeam.team_id,
            selectedAgentId: soloAgent.agent_id,
            stream: reqCtx.stream,
            questionsAsArray: reqCtx.questionsAsArray,
            modelId: reqCtx.modelId,
            protocol: reqCtx.protocol,
          };
          return { intercepted: true, response: buildFormResponse(fd), formData: fd };
        }

        // >= 2 agents: the CB old path pending_agent_task asks both at once; codex/WB/dsh/opencode split stages
        // and go through pending_agent_select. WB's form already asks split in the CC style, so let it take the
        // codex branch, to avoid the semantic ambiguity of landing on the legacy agent_task stage where the form asks only the agent
        // but is handled by the old semantics. opencode's native `question` tool can pop only
        // one question at a time and must also take the split stage.
        const useSplitStage = isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode";
        const nextStatus = useSplitStage ? "pending_agent_select" : "pending_agent_task";
        const nextStage: FormData["stage"] = useSplitStage ? "agent_select" : "agent_task";
        await store.set(compositeKey, {
          status: nextStatus,
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams: teams,
          selectedTeamId: onlyTeam.team_id,
        });
        console.log(
          `[session-init:cb] session=${compositeKey} only-team=${onlyTeam.team_id} → ${nextStatus}`,
        );
        const fd: FormData = {
          teams,
          stage: nextStage,
          selectedTeamId: onlyTeam.team_id,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        };
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }

      await store.set(compositeKey, {
        status: "pending_team_select",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: teams,
      });
      console.log(
        `[session-init:cb] session=${compositeKey} → pending_team_select (teams=${teams.length})`,
      );
      const fd: FormData = {
        teams,
        stage: "team",
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} asset-confirm max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      // CP4 . text mode: this request returns a text notice "team asset association skipped",
      // without going upstream; the next request goes through recovered.bypassed and automatically skips injection.
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "asset_confirm",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 1.5: Awaiting team selection ─────────────────────────────────────
  if (state.status === "pending_team_select") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeamsForMore = state.cachedTeams ?? [];

    // -- WorkBuddy / opencode: team MORE paging interception --
    // WB/OC reuse the CB state machine + the paginated form of WB/OC form.ts (MORE_LABEL="More ->").
    // extractTeamFromOptionText does not recognize MORE and must be intercepted before it, otherwise clicking "More ->"
    // would be treated as "not recognized" and counted into attemptCount, forcing bypass only after 3 maxRetries. On a hit, bump
    // codexPageIndex.teamPage and re-send the team_select form (the page number is picked from codexPageIndex.teamPage by stage in the
    // re-render branch of session/index.ts, and passed to the pageIndex of the WB/OC form). The dsh client has no options cap,
    // teams do not paginate, so an accidental trigger is harmless.
    // Added 2026-09-03, aligned with the stance of the agent_select / task_select branches.
    if (agentSource === "workbuddy" || agentSource === "opencode" || agentSource === "dsh") {
      const curTeamPage = state.codexPageIndex?.teamPage ?? 0;
      const nextTeamPage = detectWorkbuddyMorePage(lastUserText, curTeamPage, cachedTeamsForMore.length);
      if (nextTeamPage !== null) {
        const nextPx = {
          teamPage: nextTeamPage,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB/OC team MORE page ${curTeamPage} → ${nextTeamPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeamsForMore,
          stage: "team",
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const teamId = extractTeamFromOptionText(lastUserText, cachedTeamsForMore);

    // The user actively bypasses at the team_select stage with SKIP_RE (skip / do not link / skip)
    // (P1-4 fix). Aligned with the BYPASS_MARKER branch stance of pending_agent_select (init.ts:922) / pending_task_select
    // (init.ts:1037) -- the old code missed it here, so SKIP
    // words were treated as "not recognized" and counted into attemptCount, forcing bypass only after 3 maxRetries.
    if (teamId === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams: state.cachedTeams ?? [],
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} team_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (teamId && teamId !== BYPASS_MARKER) {
      // codex/WB/dsh/opencode split stages: agent_select first -> task_select; the CB old path keeps asking agent_task at once.
      const nextStatus = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "pending_agent_select" : "pending_agent_task";
      const nextStage: FormData["stage"] = (isCodexClient || agentSource === "workbuddy" || agentSource === "dsh" || agentSource === "opencode") ? "agent_select" : "agent_task";
      const next: SessionInitState = {
        ...state,
        status: nextStatus,
        selectedTeamId: teamId,
        attemptCount: 0,
      };
      await store.set(compositeKey, next);
      console.log(`[session-init:cb] session=${compositeKey} team=${teamId} → ${nextStatus}`);
      const fd: FormData = {
        teams: state.cachedTeams ?? [],
        stage: nextStage,
        selectedTeamId: teamId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} team-select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "team",
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2a (codex-only): Awaiting agent selection ────────────────────────
  //
  // codex client only branch. After the user picks an agent at the agent_select stage -> advance to the task_select
  // stage (if the team has only 1 task, auto-select and complete directly).
  // The CB client never enters this branch.
  if (state.status === "pending_agent_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_agent_select but team=${selectedTeamId} not in cache → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // -- WorkBuddy-only: MORE paging interception --
    // WorkBuddy reuses the CB state machine + the paginated form of workbuddy/form.ts (MORE_LABEL="More ->").
    // extractAgentOnly does not recognize MORE and must be intercepted before it, otherwise clicking "More ->" is treated as not recognized ->
    // infinitely re-sending page 1. On a hit, bump agentPage and re-send the agent_select form (the page number is picked from codexPageIndex.agentPage by stage in the
    // workbuddy/opencode re-render branch of session/index.ts).
    // opencode and workbuddy share the `More ->` MORE_LABEL and the pagination semantics, so both are intercepted.
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curAgentPage = state.codexPageIndex?.agentPage ?? 0;
      const nextAgentPage = detectWorkbuddyMorePage(lastUserText, curAgentPage, team.agents.length);
      if (nextAgentPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: nextAgentPage,
          taskPage: state.codexPageIndex?.taskPage ?? 0,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB agent MORE page ${curAgentPage} → ${nextAgentPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "agent_select",
          selectedTeamId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractAgentOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} agent_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (picked) {
      const resolvedAgentId = resolveAgent(picked, cachedTeams, selectedTeamId);
      // 0 tasks -> bypass; 1 task -> auto-select and complete directly.
      if (team.tasks.length === 0) {
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} team has 0 tasks → bypass`,
        );
        await store.set(compositeKey, {
          status: "initialized",
          keyId: sessionKey,
          startedAt: state.startedAt,
          attemptCount: 0,
          userId: state.userId,
          cachedTeams,
          selectedTeamId,
          selectedAgentId: resolvedAgentId,
          sessionInfo: null,
          agentDetail: null,
          taskDetail: null,
          bypassed: true,
        } as SessionInitState);
        return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
      }
      if (team.tasks.length === 1) {
        const soleTaskId = team.tasks[0].task_id;
        console.log(
          `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} auto-select single task=${soleTaskId}`,
        );
        return await completeRegistration(
          { agent_id: resolvedAgentId, task_id: soleTaskId },
          state, cachedTeams, compositeKey, sessionKey, userId,
          config, store, messages, metadataClient, userKey, spaceId,
        );
      }
      // >= 2 tasks -> enter the task_select stage and output the next form.
      const nextState: SessionInitState = {
        ...state,
        status: "pending_task_select",
        selectedAgentId: resolvedAgentId,
        attemptCount: 0,
        // When entering a new stage clear the task page number, so paging starts from page 1. agentPage is already used up and may be kept or cleared;
        // keeping has no side effects, clearing is cleaner -- uniformly clear to 0.
        codexPageIndex: { teamPage: state.codexPageIndex?.teamPage ?? 0, agentPage: 0, taskPage: 0 },
      };
      await store.set(compositeKey, nextState);
      console.log(
        `[session-init:cb] session=${compositeKey} agent=${resolvedAgentId} → pending_task_select (tasks=${team.tasks.length})`,
      );
      const fd: FormData = {
        teams: cachedTeams,
        stage: "task_select",
        selectedTeamId,
        selectedAgentId: resolvedAgentId,
        stream: reqCtx.stream,
        questionsAsArray: reqCtx.questionsAsArray,
        modelId: reqCtx.modelId,
        protocol: reqCtx.protocol,
      };
      return { intercepted: true, response: buildFormResponse(fd), formData: fd };
    }

    // Extraction failed -> retry / bypass.
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} agent_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "agent_select",
      selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2b (codex-only): Awaiting task selection ────────────────────────
  if (state.status === "pending_task_select") {
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;
    const selectedAgentId = state.selectedAgentId;
    const team = cachedTeams.find((t) => t.team_id === selectedTeamId);
    if (!team || !selectedAgentId) {
      console.warn(
        `[session-init:cb] session=${compositeKey} pending_task_select missing team/agent (team=${selectedTeamId} agent=${selectedAgentId}) → bypass`,
      );
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    const lastUserText = getLastUserMessageText(messages);

    // -- WorkBuddy-only: MORE paging interception --
    // Same as pending_agent_select: extractTaskOnly does not recognize "More ->" and must be intercepted first. On a hit,
    // bump taskPage and re-send the task_select form (the page number is picked from codexPageIndex.taskPage by stage in the workbuddy/opencode
    // re-render branch of session/index.ts).
    if (agentSource === "workbuddy" || agentSource === "opencode") {
      const curTaskPage = state.codexPageIndex?.taskPage ?? 0;
      const nextTaskPage = detectWorkbuddyMorePage(lastUserText, curTaskPage, team.tasks.length);
      if (nextTaskPage !== null) {
        const nextPx = {
          teamPage: state.codexPageIndex?.teamPage ?? 0,
          agentPage: state.codexPageIndex?.agentPage ?? 0,
          taskPage: nextTaskPage,
        };
        await store.set(compositeKey, { ...state, codexPageIndex: nextPx });
        console.log(
          `[session-init:cb] session=${compositeKey} WB task MORE page ${curTaskPage} → ${nextTaskPage}`,
        );
        const fd: FormData = withCodexPageIndex({
          teams: cachedTeams,
          stage: "task_select",
          selectedTeamId,
          selectedAgentId,
          stream: reqCtx.stream,
          questionsAsArray: reqCtx.questionsAsArray,
          modelId: reqCtx.modelId,
          protocol: reqCtx.protocol,
        }, nextPx);
        return { intercepted: true, response: buildFormResponse(fd), formData: fd };
      }
    }

    const picked = extractTaskOnly(lastUserText, cachedTeams, selectedTeamId);

    if (picked === BYPASS_MARKER) {
      await store.set(compositeKey, {
        status: "initialized",
        keyId: sessionKey,
        startedAt: state.startedAt,
        attemptCount: 0,
        userId: state.userId,
        cachedTeams,
        selectedTeamId,
        selectedAgentId,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
        bypassed: true,
      } as SessionInitState);
      console.log(`[session-init:cb] session=${compositeKey} task_select bypass`);
      return { intercepted: false, messages: messages as Record<string, unknown>[], bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }

    if (typeof picked === "string") {
      // Hit task_id (including the defaultTaskId virtual entry) -> complete.
      return await completeRegistration(
        { agent_id: selectedAgentId, task_id: picked },
        state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Not recognized -> retry / bypass.
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} task_select max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: cachedTeams,
      stage: "task_select",
      selectedTeamId,
      selectedAgentId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 2: Awaiting agent + task selection ───────────────────────────────
  if (state.status === "pending_agent_task" || state.status === "pending_form") {
    const lastUserText = getLastUserMessageText(messages);
    const cachedTeams = state.cachedTeams ?? [];
    const selectedTeamId = state.selectedTeamId;

    // LLM-based extraction fallback was removed — engineered paths only.
    // If neither the option-text match nor the structured parser recognises
    // the reply, the caller falls through to the retry / bypass branch.
    let extracted = extractFromOptionText(lastUserText, cachedTeams, selectedTeamId)
      ?? extractStructured(lastUserText);

    if (extracted && extracted.agent_id === BYPASS_MARKER) {
      console.warn(`[session-init:cb] session=${compositeKey} unexpected bypass in agent_task, treating as extraction failure`);
      extracted = null;
    }

    if (extracted) {
      const resolvedAgentId = resolveAgent(extracted.agent_id, cachedTeams, selectedTeamId);
      const resolvedTaskId = resolveTask(
        extracted.task_id,
        cachedTeams,
        resolvedAgentId,
        selectedTeamId,
      );
      const resolved: SessionInitData = {
        agent_id: resolvedAgentId,
        task_id: resolvedTaskId,
      };

      return await completeRegistration(
        resolved, state, cachedTeams, compositeKey, sessionKey, userId,
        config, store, messages, metadataClient, userKey, spaceId,
      );
    }

    // Extraction failed → retry / reset
    state.attemptCount++;
    if (state.attemptCount >= config.maxRetries) {
      console.warn(`[session-init:cb] session=${compositeKey} max retries, abandoning`);
      await store.set(compositeKey, { status: "initialized", bypassed: true } as SessionInitState);
      const textBypass = tryBuildTextModeBypassResult(reqCtx);
      if (textBypass) return textBypass;
      return { intercepted: false, bypassed: true, justRegistered: true, resetFlow: state?.resetFlow ?? false };
    }
    await store.set(compositeKey, state);
    const fd: FormData = {
      teams: state.cachedTeams ?? [],
      stage: "agent_task",
      selectedTeamId: state.selectedTeamId,
      retry: true,
      stream: reqCtx.stream,
      questionsAsArray: reqCtx.questionsAsArray,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
    };
    return { intercepted: true, response: buildFormResponse(fd), formData: fd };
  }

  // ── Case 3: Initialized ───────────────────────────────────────────────────
  const bypassed = (state as any).bypassed === true;
  const agent = bypassed ? null : (state.agentDetail ?? null);
  const task = bypassed ? null : (state.taskDetail ?? null);
  const out = applyArtifactsAndContext(messages, agent, task, sessionKey, config);
  return { intercepted: false, messages: out, sessionInfo: state.sessionInfo, bypassed };
}

// ── CP3 · Text-Mode Preprocess Helpers ─────────────────────────────────────
//
// The following 4 helper functions serve only the text-mode preprocessing hook (see the CP3 section above). They are **not
// called by any existing code path** and are purely additive. Placed at the end of the file to keep the diff of existing functions minimal.

/**
 * Decide whether the current status is a "pending_* select stage that text-mode preprocessing needs to handle".
 *
 * Only 4 are handled: pending_asset_confirm / pending_team_select /
 * pending_agent_select / pending_task_select.
 *
 * pending_agent_task (the CB old one-shot path, which workbuddy never reaches) is not handled, nor are intermediate states like
 * pending_agent_select_ambiguous (the existing code has none of these).
 */
function isTextModePendingSelectStage(status: string | undefined): boolean {
  return (
    status === "pending_asset_confirm" ||
    status === "pending_team_select" ||
    status === "pending_agent_select" ||
    status === "pending_task_select"
  );
}

/**
 * status -> FormStage mapping (aligned with workbuddy/form.ts::FormStage).
 * Only the 4 pending states are mapped; everything else returns null.
 */
function statusToTextModeStage(
  status: string | undefined,
): "asset_confirm" | "team" | "agent_select" | "task_select" | null {
  switch (status) {
    case "pending_asset_confirm":
      return "asset_confirm";
    case "pending_team_select":
      return "team";
    case "pending_agent_select":
      return "agent_select";
    case "pending_task_select":
      return "task_select";
    default:
      return null;
  }
}

/**
 * Read the page number corresponding to the current stage (using teamPage/agentPage/
 * taskPage of state.codexPageIndex -- reusing the same storage field as workbuddy card mode, keeping behaviour consistent;
 * asset_confirm has only 2 fixed options with no pagination, always 0).
 */
function readCurrentPageForStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
): number {
  const pi = state.codexPageIndex;
  switch (stage) {
    case "team":
      return pi?.teamPage ?? 0;
    case "agent_select":
      return pi?.agentPage ?? 0;
    case "task_select":
      return pi?.taskPage ?? 0;
    case "asset_confirm":
      return 0;
    default:
      return 0;
  }
}

/**
 * Return a **new** SessionInitState (not mutating the argument), updating the page number of the corresponding stage
 * to newPage. asset_confirm has no pagination -> returned as is.
 */
function writeCurrentPageForStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
  newPage: number,
): SessionInitState {
  if (stage === "asset_confirm") return state;
  const oldPi = state.codexPageIndex ?? {};
  const nextPi = { ...oldPi };
  if (stage === "team") nextPi.teamPage = newPage;
  else if (stage === "agent_select") nextPi.agentPage = newPage;
  else if (stage === "task_select") nextPi.taskPage = newPage;
  return { ...state, codexPageIndex: nextPi };
}

/**
 * Construct FormData for the paginate-* short-circuit re-render (the workbuddy dispatch of the session/index.ts layer
 * stuffs it into buildWorkBuddyTextFormResponse).
 *
 * Key: **does not advance the stage, does not consume attemptCount** -- the stage stays unchanged, retry=false.
 */
function buildFormDataForTextModeStage(
  state: SessionInitState,
  stage: "asset_confirm" | "team" | "agent_select" | "task_select",
  reqCtx: SessionRequestContext,
): FormData {
  return {
    teams: state.cachedTeams ?? [],
    stage,
    selectedTeamId: state.selectedTeamId,
    selectedAgentId: state.selectedAgentId,
    // codexPageIndex has already been updated by writeCurrentPageForStage, passed through to downstream rendering
    teamPage: state.codexPageIndex?.teamPage,
    agentPage: state.codexPageIndex?.agentPage,
    taskPage: state.codexPageIndex?.taskPage,
    retry: false,
    stream: reqCtx.stream,
    questionsAsArray: reqCtx.questionsAsArray,
    modelId: reqCtx.modelId,
    protocol: reqCtx.protocol,
  };
}

/**
 * **Does not mutate the original array**; returns a new messages array: the content of the last role="user"
 * message is replaced with newContent.
 *
 * If no user message is found -> returned as is (passthrough; should not happen but is a fallback).
 *
 * Note: here we **only handle the case where content is a string** -- in text mode the WorkBuddy
 * client sends plain-text user messages for sure, with no multipart. In the extreme case (content is an
 * array) it is also kept as is, letting the CB extractor handle it itself.
 */
function replaceLastUserMessageContentImmutable(
  messages: MessageArr,
  newContent: string,
): MessageArr {
  // Look backwards for the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      // Only overwrite the case where content is a string; keep other content types as is
      if (typeof m.content !== "string") return messages;
      const copy = [...messages];
      copy[i] = { ...m, content: newContent };
      return copy;
    }
  }
  return messages;
}

/**
 * CP4 . text-mode max-retry bypass fallback.
 *
 * Returns an intercepted result with a response if and only if `reqCtx.capabilities?.askUserQuestion === false`
 * -- sending the text notice "team asset association skipped" to the client,
 * and this request is **not sent upstream**. Returning undefined means taking the original bypass path (transparent
 * transfer to the upstream LLM), with existing CB / codex / dsh / opencode behaviour unchanged.
 *
 * The state in the store is set by the caller before the call to `{status: "initialized",
 * bypassed: true}`, and the next request's recovered goes through the `recovered.bypassed` branch of handler.ts
 * and automatically skips injection -- fully aligned with the existing bypass semantics.
 */
function tryBuildTextModeBypassResult(
  reqCtx: SessionRequestContext,
): SessionInitResult | undefined {
  if (reqCtx.capabilities?.askUserQuestion !== false) return undefined;
  const response = buildBypassNoticeResponse(reqCtx.modelId, reqCtx.stream === true);
  return {
    intercepted: true,
    response,
    bypassed: true,
    justRegistered: true,
  };
}