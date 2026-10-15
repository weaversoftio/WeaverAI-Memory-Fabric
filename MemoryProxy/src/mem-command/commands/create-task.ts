/**
 * mem:create-task - generate a Task from the current conversation context and bind it to this session.
 *
 * Interaction (aligned with the TAPD requirement "user confirmation" gate):
 *
 *   ┌ session not bound to a real task:
 *   │    no args -> LLM generates title+desc -> persist + bind directly (no confirm needed)
 *   │    with args -> title = user args (<=40 chars), LLM only generates desc -> persist + bind directly
 *   │            LLM failure -> degrade: leave desc empty, the task is still persisted
 *   │
 *   ├ session already bound to a real task:
 *   │    generate a new draft -> write to pending-store (TTL 5 minutes) -> return "preview + pick-one-of-three guidance":
 *   │      1) mem:create-task confirm - overwrite the binding, create new
 *   │      2) mem:update-task [new description] - keep using the current Task and only update the description
 *   │      3) mem:create-task cancel - revoke
 *   │
 *   ├ `mem:create-task confirm`:
 *   │    take the draft from pending -> create a new task -> overwrite the session binding -> clear pending
 *   │
 *   └ `mem:create-task cancel`:
 *        clear pending, nothing persisted
 *
 * Argument parsing:
 *   - `confirm` / `cancel` (case-insensitive) on their own are treated as subcommands
 *   - any other args are used as lockedTitle (title hint for the first call)
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  createTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;
const TITLE_MAX_LEN = 40;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function truncateTitle(raw: string): string {
  const s = raw.trim();
  return s.length > TITLE_MAX_LEN ? s.slice(0, TITLE_MAX_LEN) : s;
}

/** Decide whether args is a confirm / cancel subcommand. Hits only when the whole string, after trim, is strictly equal. */
function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeCreateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const recentMessages = ctx.bodyMessages ?? [];
  const rawArgs = (ctx.args ?? "").trim();

  const finalize = (
    messageText: string,
    success: boolean,
    data: Record<string, unknown>,
  ): MemCommandResult => {
    const response = buildMemResponse(messageText, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    });
    return { success, messageText, data, response };
  };

  const subcommand = parseSubcommand(rawArgs);

  // -- confirm branch --------------------------------------------------------
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task action to confirm (it may have timed out or been cancelled). Run \`mem:create-task [title]\` again.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task creation failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "create_failed", detail: result.error },
      );
    }

    const prevLine = result.previousTaskId
      ? `\n\n(Previous Task \`${result.previousTaskId}\` unbound)`
      : "";
    return finalize(
      `✅ New Task created and bound.\n\n` +
        `- **Title**: ${result.title}\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **Description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**: \`${result.taskId}\`${prevLine}`,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
        ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
        ...(result.error ? { bind_warning: result.error } : {}),
      },
    );
  }

  // -- cancel branch ---------------------------------------------------------
  if (subcommand === "cancel") {
    const result = await cancelPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });
    if (!result.success) {
      return finalize(
        `⚠️ Cancel failed: ${result.error ?? "unknown"}`,
        false,
        { reason: "cancel_failed", detail: result.error },
      );
    }
    const msg = result.cancelled
      ? `✅ Pending Task action cancelled.`
      : `ℹ️ There is no pending Task action.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // -- first-call branch -----------------------------------------------------

  const lockedTitle = rawArgs.length > 0 ? truncateTitle(rawArgs) : undefined;

  if (recentMessages.length === 0) {
    return finalize(
      `⚠️ This request carries no conversation messages; \`mem:create-task\` needs the recent conversation as context to draft a Task.` +
        `\n\nTip: have a few turns with the AI first, then run this command.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await createTaskFromSession({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    recentMessages,
    // Option D: the taskDraft LLM follows the main model - pass through the client's model / upstream / apiKey for this call.
    // upstreamProtocol is independent of ctx.protocol (the latter only governs the SSE skeleton format of response rendering,
    // the former decides whether the taskDraft request hits /messages | /chat/completions | /responses).
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.upstreamUrl ? { upstreamUrl: ctx.upstreamUrl } : {}),
    ...(ctx.upstreamProtocol ? { protocol: ctx.upstreamProtocol } : {}),
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(lockedTitle ? { lockedTitle, hint: rawArgs } : {}),
  });

  // Persist failed
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = lockedTitle
      ? ""
      : "\n\nYou can:\n1. Try again later\n2. Run `mem:create-task <your title>` to set the title yourself (the LLM then only writes the description; if that fails too, an empty description is used)";
    return finalize(
      `❌ Task creation failed: ${detail}${hintLine}`,
      false,
      { reason: "create_failed", detail },
    );
  }

  // Already-bound branch: pending preview
  if (result.pending && result.pending.kind === "create") {
    const p = result.pending;
    const currentLine = p.currentTaskTitle
      ? `\`${p.currentTaskId}\` "${p.currentTaskTitle}"`
      : `\`${p.currentTaskId}\``;
    return finalize(
      `⚠️ This session is already bound to Task ${currentLine}.\n\n` +
        `**New Task preview**\n` +
        `- Title: ${p.draftTitle}\n` +
        `- Description: ${trimDesc(p.draftDescription)}\n\n` +
        `Choose the next step:\n` +
        `1. \`mem:create-task confirm\` — replace the current binding and create the new Task\n` +
        `2. \`mem:update-task\` or \`mem:update-task <new description>\` — keep the current Task and only update its description (no new Task)\n` +
        `3. \`mem:create-task cancel\` — cancel, change nothing`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "create",
          draft_title: p.draftTitle,
          draft_description: p.draftDescription,
          current_task_id: p.currentTaskId,
          ...(p.currentTaskTitle ? { current_task_title: p.currentTaskTitle } : {}),
        },
      },
    );
  }

  // Unbound branch: persisted directly
  return finalize(
    `✅ Task created and bound to this session.\n\n` +
      `- **Title**: ${result.title}\n` +
      `- **Status**: ${result.status ?? "running"}\n` +
      `- **Description**: ${trimDesc(result.description)}\n` +
      `- **Task ID**: \`${result.taskId}\`\n\n` +
      `Use \`mem:update-task\` later to add progress.`,
    true,
    {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      ...(result.error ? { bind_warning: result.error } : {}),
    },
  );
}
