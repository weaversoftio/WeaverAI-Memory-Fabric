/**
 * Core business logic of mem:create-task / mem:update-task:
 * starting from the current session context, generate a Task, write it to metadata, and bind it to the session.
 *
 * Interaction model (the "user confirmation" gate -- destructive operations must first draft, then confirm):
 *   - createTaskFromSession
 *       no real task bound -> the LLM generates title+description -> persist + bind directly (one step)
 *       real task already bound -> generate a new draft -> write pending -> return pending, awaiting user confirm/cancel
 *   - updateTaskFromSession
 *       no task_id bound -> intercept and return an error, guiding the user to run mem:create-task first
 *       bound: fetch the current task -> generate a draft (including a status suggestion) -> write pending -> return pending
 *              non-creators are no longer rejected; instead a warning is attached to pending, and the user is told at confirm time
 *   - confirmPendingTaskAction / cancelPendingTaskAction
 *       take the payload out of pending-store, perform the real create / update / overwrite binding / clear pending
 *
 * Key constraints (aligned with the kernel):
 *   - pass agent_id at create time so the kernel associates the current Agent (the original wording of the TAPD requirement)
 *   - **do not change the title** when persisting (aligned with the existing product convention; the kernel allows changing it but the product does not)
 *   - on update the status is proposed by the LLM, and the proxy passes it straight through to the kernel without enum validation
 *   - creator_user_id / team_id are taken strictly from sessionInfo, to prevent privilege escalation
 *   - taskDraft not configured = return "config missing" directly (no local fallback)
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { MemCommandMessage } from "../mem-command/types.js";
import { getSessionStore } from "../session/store.js";
import type { SessionInitState, SessionInfo } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";
import type { TaskEntity } from "../meta/client.js";
import { generateTaskDraft, type TaskDraftConfig } from "../mem-command/task-draft-generator.js";
import {
  clearPending,
  getPending,
  makePendingKey,
  setPending,
  type PendingCreatePayload,
  type PendingUpdatePayload,
} from "../mem-command/pending-store.js";

// -- Input / output types --------------------------------------------------

/**
 * The taskDraft LLM follows the main model (Plan D): the model / upstream / key actually used by the client in the current request.
 * The handler has already resolved them by per-agent rules; session-task only passes them through to task-draft-generator.
 *
 * If any one of the three fields is missing -> resolveTaskDraftConfig returns "not configured",
 * and the command layer assembles the error text for the user (no fallback, and no longer depends on config.memCommand.taskDraft).
 */
export interface TaskDraftUpstream {
  /** The client's model for the current request (the real model_id after body.model normalization). */
  model?: string;
  /** Per-agent resolved upstream base url (without the specific endpoint). */
  upstreamUrl?: string;
  /** Upstream API family, deciding the generator request shape. */
  protocol?: "openai" | "anthropic" | "responses";
  /** The apiKey used when forwarding (the user key passed through by the client). */
  apiKey?: string;
}

export interface CreateTaskFromSessionInput extends TaskDraftUpstream {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  /** User hint (free text after mem:create-task), may be empty */
  hint?: string;
  /** Recent conversation (used to generate the draft) */
  recentMessages: MemCommandMessage[];
  /**
   * The title the user wrote after mem:create-task (original text; the 40-char truncation is the caller's responsibility).
   *   - with value: the title is locked, the LLM only generates the description; if the LLM fails it degrades to an empty desc, and the task is still persisted.
   *   - without value: both title + description are inferred by the LLM from the conversation; if the LLM fails an error is returned directly.
   */
  lockedTitle?: string;
}

export interface UpdateTaskFromSessionInput extends TaskDraftUpstream {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  hint?: string;
  recentMessages: MemCommandMessage[];
  /**
   * The description the user wrote after mem:update-task (original text).
   *   - with value: the description is replaced directly with that text, without calling the LLM.
   *   - without value: call the LLM to diff out a new description (not persisted when changed=false).
   */
  directDescription?: string;
}

/** confirm/cancel input (no recentMessages, because the draft is already in pending) */
export interface PendingActionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
}

/** Pending summary on the first call of the create command (for the command layer to assemble preview text) */
export interface PendingCreateInfo {
  kind: "create";
  draftTitle: string;
  draftDescription: string;
  currentTaskId: string;
  currentTaskTitle?: string;
}

/** Pending summary on the first call of the update command */
export interface PendingUpdateInfo {
  kind: "update";
  taskId: string;
  currentTitle?: string;
  currentDescription?: string;
  currentStatus?: string;
  draftDescription: string;
  statusSuggestion?: string;
}

export type PendingInfo = PendingCreateInfo | PendingUpdateInfo;

export interface TaskFromSessionResult {
  success: boolean;
  /** taskId on success */
  taskId?: string;
  /** Final title on success */
  title?: string;
  /** Final description on success */
  description?: string;
  /** Final status on success */
  status?: string;
  /** update mode: true when the LLM judged "no update needed" -- not persisted */
  noUpdateNeeded?: boolean;
  /**
   * create mode: the session is already bound to a task_id; a legacy compatibility slot, and under the new interaction pending is also given.
   * The field name is kept for compatibility with the response envelope of the HTTP handler (respond() reads it to decide 409).
   */
  alreadyBound?: boolean;
  /**
   * The first call generated a pending draft awaiting user confirmation. Not persisted; the command layer must assemble preview text,
   * guiding the next-round reply `mem:create-task confirm` / `mem:update-task confirm` or `... cancel`.
   */
  pending?: PendingInfo;
  /** confirm branch: there is no corresponding pending on the session (may have timed out / been cancelled / never generated) */
  noPending?: boolean;
  /** cancel branch: whether a pending was hit and cleared */
  cancelled?: boolean;
  /** create overwrite branch: the previously bound old task_id (for the returned text) */
  previousTaskId?: string;
  /** Failure reason, for callers to assemble user-visible text */
  error?: string;
}

// -- Internal: common check for getting the session state -------------------

interface ResolvedSession {
  state: SessionInitState;
  sessionInfo: SessionInfo;
  teamId: string;
  userId: string;
  currentTaskId?: string;
}

function resolveSession(
  sessionKey: string,
  agentSource: string,
  config: ProxyConfig,
): ResolvedSession | { error: string } {
  if (!sessionKey) return { error: "session_key is required" };

  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;
  const teamId = sessionInfo.team_id ?? "";
  const userId = sessionInfo.user_id ?? "";
  if (!teamId || !userId) {
    return { error: "session missing team_id/user_id (initialization incomplete)" };
  }

  // "Skip for now" goes through config.sessionInit.defaultTaskId (a virtual value, nonexistent in the kernel),
  // treated as **no real task bound** -- create-task is allowed, update-task is forbidden (the latter returns an error via the no-task branch).
  const rawTaskId = sessionInfo.task_id;
  const defaultTaskId = config.sessionInit?.defaultTaskId;
  const isVirtualDefault = !!rawTaskId && !!defaultTaskId && rawTaskId === defaultTaskId;
  const currentTaskId = isVirtualDefault ? undefined : rawTaskId;

  return { state, sessionInfo, teamId, userId, ...(currentTaskId ? { currentTaskId } : {}) };
}

// -- Internal: check and get the taskDraft config ----------------------------

const DEFAULT_TASK_DRAFT_TIMEOUT_MS = 20000;

/**
 * Plan D (including the env-var override extension): taskDraft LLM config resolution.
 *
 * ## Priority (high to low)
 *
 *   1. **Env-var override** (ops escape hatch)
 *      - MEMORY_LLM_PROTOCOL -> overrides protocol
 *      - MEMORY_LLM_API_KEY  -> overrides apiKey
 *      - MEMORY_LLM_BASE_URL -> overrides upstreamUrl
 *      - MEMORY_LLM_MODEL    -> overrides model
 *
 *   2. **Client request** (the original Plan D "follow-the-client" behaviour)
 *      - upstream.protocol / upstream.apiKey / upstream.upstreamUrl / upstream.model
 *
 *   3. **Error if missing**
 *      - if any of model / upstreamUrl / apiKey is missing -> return { error: "..." }
 *      - when protocol is missing no error is raised; task-draft-generator uses the default protocol
 *
 * ## Usage scenario
 *
 * When deployed behind an OpenAI-compatible gateway (such as rcaaitoken), the protocol=anthropic
 * passed by the client (such as Claude Code) does not match the upstream's actual protocol, causing 401.
 * With env-var overrides, ops can fix it at deploy time without changing code.
 *
 * ## Tests
 *
 * See src/routes/__tests__/session-task.test.ts
 */
export function resolveTaskDraftConfig(
  upstream: TaskDraftUpstream,
): { cfg: TaskDraftConfig } | { error: string } {
  const { model, upstreamUrl, protocol, apiKey } = upstream;

  // Env vars take priority: allows the ops layer to fully take over the task-draft LLM config
  const envProtocol = process.env.MEMORY_LLM_PROTOCOL as "openai" | "anthropic" | "responses" | undefined;
  const envApiKey = process.env.MEMORY_LLM_API_KEY;
  const envBaseUrl = process.env.MEMORY_LLM_BASE_URL;
  const envModel = process.env.MEMORY_LLM_MODEL;

  const effectiveModel = envModel || model;
  const effectiveUrl = envBaseUrl || upstreamUrl;
  const effectiveApiKey = envApiKey || apiKey;
  const effectiveProtocol = envProtocol || protocol;

  if (!effectiveModel || !effectiveUrl || !effectiveApiKey) {
    return {
      error:
        "task_draft is not configured (missing model / upstream url / apiKey). " +
        "Set MEMORY_LLM_MODEL, MEMORY_LLM_BASE_URL, MEMORY_LLM_API_KEY env vars, " +
        "or ensure handler passes them in the request.",
    };
  }

  return {
    cfg: {
      enabled: true,
      model: effectiveModel,
      url: effectiveUrl,
      apiKey: effectiveApiKey,
      timeoutMs: DEFAULT_TASK_DRAFT_TIMEOUT_MS,
      ...(effectiveProtocol ? { protocol: effectiveProtocol } : {}),
    },
  };
}

function getClientFromResolved(resolved: ResolvedSession, config: ProxyConfig, fallbackSpaceId: string) {
  return getMetadataClient(
    config.coreSkill,
    resolved.sessionInfo.space_id ?? fallbackSpaceId,
    resolved.sessionInfo.user_key ?? "",
  );
}

function normalizeDesc(d: string | null | undefined): string | undefined {
  return d == null ? undefined : d;
}

/** Generate the pending key from the resolved session (including the team/agent/session triple). */
function pendingKeyOf(resolved: ResolvedSession, agentSource: string, sessionKey: string): string {
  return makePendingKey({
    team_id: resolved.teamId,
    // The agent of pending-store uses sessionInfo.agent_id (a kernel-side concept); fall back to agentSource if missing
    agent_id: resolved.sessionInfo.agent_id ?? agentSource,
    session_id: sessionKey,
  });
}

// -- Internal: the two atomic operations that actually persist (direct on first call / also used at confirm) ----

/**
 * Execute create: call kernel createTask, then bind the session.
 * agent_id is taken from sessionInfo if possible; if missing it is not passed (left to the kernel).
 */
async function doCreateAndBind(
  resolved: ResolvedSession,
  input: { sessionKey: string; agentSource: string; config: ProxyConfig; spaceId: string },
  title: string,
  description: string,
): Promise<{ ok: true; task: TaskEntity; bindWarning?: string } | { ok: false; error: string }> {
  let created: TaskEntity;
  try {
    const client = getClientFromResolved(resolved, input.config, input.spaceId);
    created = await client.createTask({
      team_id: resolved.teamId,
      creator_user_id: resolved.userId,
      title,
      description,
      ...(resolved.sessionInfo.agent_id ? { agent_id: resolved.sessionInfo.agent_id } : {}),
    });
  } catch (err) {
    return { ok: false, error: `metadata createTask failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await bindTaskIdToSession(input.sessionKey, input.agentSource, created.task_id);
  } catch (err) {
    return {
      ok: true,
      task: created,
      bindWarning: `task created but session bind failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, task: created };
}

// -- Core: create-task -----------------------------------------------------
//
// Interaction layers:
//   unbound + any arguments -> the LLM generates a draft -> persist immediately (no confirm needed)
//   real task already bound -> the LLM generates a draft -> write pending, awaiting confirm/cancel

export async function createTaskFromSession(
  input: CreateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const draftCfg = resolveTaskDraftConfig(input);
  if ("error" in draftCfg) return { success: false, error: draftCfg.error };

  // Step 1: the LLM generates the draft (with lockedTitle, only the description is produced)
  const draft = await generateTaskDraft(draftCfg.cfg, {
    mode: "create",
    hint: input.hint,
    recentMessages: input.recentMessages,
    ...(input.lockedTitle ? { lockedTitle: input.lockedTitle } : {}),
  });

  // Step 1a: result normalization
  //
  // Three-tier degradation (fixed 2026-08-18 for an excessive failure rate):
  //   1) draft.ok=true          -> use the LLM result
  //   2) draft.ok=false + lockedTitle → title=lockedTitle, desc=""
  //   3) draft.ok=false + no arguments -> fall back to "untitled-task_yyMMdd_HHmm", desc="", letting the user fill in later via mem:update-task
  //
  // Previously tier 3 was "strict error", so any LLM fluctuation made the user retry 3 times -- a terrible UX.
  // Now a default name is given and bound, and after getting the taskId the user can add a description any time;
  // the fallback error message is passed through to the upper layer via bindWarning, and the UI layer can optionally hint "AI naming failed, default name used".
  let finalTitle: string;
  let finalDescription: string;
  let draftFallbackWarning: string | undefined;
  if (draft.ok) {
    finalTitle = draft.title;
    finalDescription = draft.description;
  } else if (input.lockedTitle) {
    // With arguments + LLM failure -> degrade: title from the arguments, desc left empty
    finalTitle = input.lockedTitle;
    finalDescription = "";
    draftFallbackWarning = `AI description failed (${draft.error}); saved with empty description`;
  } else {
    // No arguments + LLM failure -> fallback: "untitled-task_yyMMdd_HHmm"
    finalTitle = buildFallbackTaskTitle();
    finalDescription = "";
    draftFallbackWarning = `AI draft failed (${draft.error}); saved with default title, use mem:update-task to refine`;
  }

  // Step 2a: real task already bound -> write pending, awaiting confirm to overwrite the binding
  if (resolved.currentTaskId) {
    let boundTitle: string | undefined;
    try {
      const client = getClientFromResolved(resolved, input.config, input.spaceId);
      const t = await client.getTask(resolved.currentTaskId);
      boundTitle = t.title;
    } catch {
      // Failing to fetch the old task title does not block either (it only affects the preview display)
    }
    const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
    const payload: PendingCreatePayload = {
      kind: "create",
      draft: {
        title: finalTitle,
        description: finalDescription,
        ...(input.hint ? { hint: input.hint } : {}),
      },
      currentTaskId: resolved.currentTaskId,
      ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
    };
    setPending(key, payload);
    return {
      success: true,
      alreadyBound: true,
      taskId: resolved.currentTaskId,
      ...(boundTitle ? { title: boundTitle } : {}),
      pending: {
        kind: "create",
        draftTitle: finalTitle,
        draftDescription: finalDescription,
        currentTaskId: resolved.currentTaskId,
        ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
      },
      ...(draftFallbackWarning ? { error: draftFallbackWarning } : {}),
    };
  }

  // Step 2b: unbound -> persist directly
  const persisted = await doCreateAndBind(resolved, input, finalTitle, finalDescription);
  if (!persisted.ok) return { success: false, error: persisted.error };
  const created = persisted.task;
  // Merge the two kinds of warning: AI fallback + bind failure, both passed through to the upper layer via the error field
  // (the field name error is a historical leftover; the semantics are "success=true but with a warning")
  const combinedWarning = [draftFallbackWarning, persisted.bindWarning]
    .filter((w): w is string => !!w)
    .join("; ");
  return {
    success: true,
    taskId: created.task_id,
    title: created.title,
    description: normalizeDesc(created.description),
    status: created.status,
    ...(combinedWarning ? { error: combinedWarning } : {}),
  };
}

/**
 * Generate "untitled-task_yyyyMMdd_HHmm" as the LLM fallback title.
 *
 * The timestamp is precise to the minute, balancing readability and searchability:
 *   - when the user sees "untitled-task_260818_1710" they can immediately locate when it was created
 *   - no seconds, to avoid duplicate names from consecutive creation -- and opening two tasks within a minute is abnormal
 * Guarantees <= MAX_TITLE_LEN(40) chars.
 */
function buildFallbackTaskTitle(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `untitled-task_${yy}${MM}${dd}_${HH}${mm}`;
}

// -- Core: update-task -----------------------------------------------------
//
// Interaction layers (confirm needed every time):
//   unbound -> intercept and return an error, letting the user create-task first
//   bound -> fetch the current task -> generate a draft (including a status suggestion) -> write pending -> return pending
//          non-creators are rejected directly (the kernel does not support cross-user update either; the proxy side gives guidance to create-task up front)

export async function updateTaskFromSession(
  input: UpdateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  if (!resolved.currentTaskId) {
    return {
      success: false,
      error:
        "no task bound to this session (session is in \"Skip for now\" mode or task_id missing); " +
        "use mem:create-task to create and bind a new task first",
    };
  }

  // Only the no-arguments branch needs the LLM config
  if (!input.directDescription) {
    const draftCfg = resolveTaskDraftConfig(input);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };
  }

  // Step 1: fetch the current task
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let current: TaskEntity;
  try {
    current = await client.getTask(resolved.currentTaskId);
  } catch (err) {
    return {
      success: false,
      error: `metadata getTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Non-creators are rejected directly (the kernel side still rejects cross-user update via the owner-check; the proxy blocks it up front to give clear guidance)
  if (current.creator_user_id && current.creator_user_id !== resolved.userId) {
    return {
      success: false,
      error: "not_creator",
    };
  }

  // Step 2: decide the new description + statusSuggestion
  let newDescription: string;
  let statusSuggestion: string | undefined;
  if (input.directDescription !== undefined) {
    // With arguments: replace directly, without calling the LLM or producing a status suggestion
    newDescription = input.directDescription;
  } else {
    const draftCfg = resolveTaskDraftConfig(input);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };

    const draft = await generateTaskDraft(draftCfg.cfg, {
      mode: "update",
      hint: input.hint,
      recentMessages: input.recentMessages,
      currentTask: {
        title: current.title,
        description: current.description ?? "",
        status: current.status ?? "running",
      },
    });
    if (!draft.ok) return { success: false, error: `draft failed: ${draft.error}` };
    if (!draft.changed) {
      // LLM judged no change -> do not write pending, return noUpdateNeeded directly
      return {
        success: true,
        noUpdateNeeded: true,
        taskId: current.task_id,
        title: current.title,
        description: normalizeDesc(current.description),
        status: current.status,
      };
    }
    newDescription = draft.description;
    statusSuggestion = draft.suggestedStatus;
  }

  // Step 3: write pending, awaiting confirm
  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload: PendingUpdatePayload = {
    kind: "update",
    draft: {
      taskId: current.task_id,
      description: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    },
  };
  setPending(key, payload);

  return {
    success: true,
    taskId: current.task_id,
    title: current.title,
    description: normalizeDesc(current.description),
    status: current.status,
    pending: {
      kind: "update",
      taskId: current.task_id,
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.description ? { currentDescription: current.description } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      draftDescription: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
    },
  };
}

// -- Core: confirm / cancel --------------------------------------------------

/**
 * Called when the user replies `mem:create-task confirm` or `mem:update-task confirm`.
 * Dispatch by kind in pending:
 *   - create -> doCreateAndBind (overwrites the original binding)
 *   - update -> kernel updateTask (description + status passed through)
 * After a successful persist, pending is cleared; on failure pending is kept (the user can retry).
 */
export async function confirmPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload = getPending(key);
  if (!payload) {
    return { success: false, noPending: true, error: "no pending task action (may have expired or been cancelled)" };
  }

  if (payload.kind === "create") {
    const previousTaskId = payload.currentTaskId;
    const persisted = await doCreateAndBind(
      resolved,
      input,
      payload.draft.title,
      payload.draft.description,
    );
    if (!persisted.ok) {
      // On persist failure keep pending so the user can retry
      return { success: false, error: persisted.error };
    }
    clearPending(key);
    const t = persisted.task;
    return {
      success: true,
      taskId: t.task_id,
      title: t.title,
      description: normalizeDesc(t.description),
      status: t.status,
      previousTaskId,
      ...(persisted.bindWarning ? { error: persisted.bindWarning } : {}),
    };
  }

  // update branch
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let updated: TaskEntity;
  try {
    updated = await client.updateTask(payload.draft.taskId, {
      description: payload.draft.description,
      ...(payload.draft.statusSuggestion ? { status: payload.draft.statusSuggestion } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: `metadata updateTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearPending(key);
  return {
    success: true,
    taskId: updated.task_id,
    title: updated.title,
    description: normalizeDesc(updated.description),
    status: updated.status,
  };
}

/**
 * Called when the user replies `mem:create-task cancel` or `mem:update-task cancel`:
 * clear pending, do not persist. Return cancelled=true so the command layer can assemble the hint text.
 */
export async function cancelPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const existed = clearPending(key);
  return { success: true, cancelled: existed };
}

// -- Internal: write the taskId back to sessionInfo ------------------------

async function bindTaskIdToSession(
  sessionKey: string,
  agentSource: string,
  taskId: string,
): Promise<void> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);
  if (!state || !state.sessionInfo) {
    throw new Error(`session ${sessionKey} vanished during bind`);
  }
  const newSessionInfo: SessionInfo = { ...state.sessionInfo, task_id: taskId };
  const newState: SessionInitState = { ...state, sessionInfo: newSessionInfo };
  await store.set(compositeKey, newState);
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────

/**
 * POST /v3/session/create-task
 *
 * For the panel frontend / e2e. The body looks like:
 *   { session_key, agent_source, space_id, hint?, locked_title?, recent_messages?: [...] }
 * If recent_messages is not provided, it returns "no recent messages" -- the panel must pass it proactively (fetched from
 * conversation/query, the latest N entries).
 */
export function createSessionCreateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `create-task-${Date.now()}` }, 400);
    }

    const parsed = parseCreateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `create-task-${Date.now()}` }, 400);
    }

    const result = await createTaskFromSession({ ...parsed, config });
    return respond(c, result, "create-task");
  };
}

/**
 * POST /v3/session/update-task -- same as above but goes through the update branch.
 */
export function createSessionUpdateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `update-task-${Date.now()}` }, 400);
    }

    const parsed = parseUpdateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `update-task-${Date.now()}` }, 400);
    }

    const result = await updateTaskFromSession({ ...parsed, config });
    return respond(c, result, "update-task");
  };
}

// -- HTTP body parsing -----------------------------------------------------

function parseCommonBody(
  body: Record<string, unknown>,
):
  | { sessionKey: string; agentSource: string; spaceId: string; hint?: string; recentMessages: MemCommandMessage[] }
  | { error: string } {
  const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
  if (!sessionKey) return { error: "session_key is required" };
  const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
  const spaceId = typeof body.space_id === "string" ? body.space_id : "";
  const hint = typeof body.hint === "string" ? body.hint : undefined;

  const rawMsgs = Array.isArray(body.recent_messages) ? body.recent_messages : [];
  const recentMessages: MemCommandMessage[] = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (
      (role === "user" || role === "assistant" || role === "system") &&
      typeof content === "string" &&
      content.length > 0
    ) {
      recentMessages.push({ role, content });
    }
  }

  return { sessionKey, agentSource, spaceId, hint, recentMessages };
}

function parseCreateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      lockedTitle?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const lockedTitle = typeof body.locked_title === "string" && body.locked_title.trim().length > 0
    ? body.locked_title.trim()
    : undefined;
  return { ...base, ...(lockedTitle ? { lockedTitle } : {}) };
}

function parseUpdateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      directDescription?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const directDescription = typeof body.direct_description === "string"
    ? body.direct_description
    : undefined;
  return { ...base, ...(directDescription !== undefined ? { directDescription } : {}) };
}

function respond(c: Context, result: TaskFromSessionResult, tag: string): Response {
  const requestId = `${tag}-${Date.now()}`;
  if (!result.success) {
    const isNoPending = result.noPending === true;
    const isNotFound = result.error?.includes("not found") || result.error?.includes("no task bound");
    const status = isNoPending ? 404 : isNotFound ? 404 : 500;
    const code = isNoPending ? 40402 : isNotFound ? 40401 : 50001;
    return c.json(
      {
        code,
        message: result.error,
        request_id: requestId,
      },
      status,
    );
  }
  return c.json({
    code: 0,
    message: "ok",
    request_id: requestId,
    data: {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      no_update_needed: result.noUpdateNeeded ?? false,
      ...(result.pending ? { pending: result.pending } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
    },
  });
}
