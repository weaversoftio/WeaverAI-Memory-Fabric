/**
 * mem:update-task - update an already-bound Task.
 *
 * Interaction (user confirmation required every time):
 *
 *   ┌ session not bound -> intercept, guide to mem:create-task
 *   ├ first call (no confirm/cancel subcommand):
 *   │    with args -> description replaced directly (skip LLM) -> write pending -> preview
 *   │    no args -> LLM diff generates new desc + status suggestion -> write pending -> preview
 *   │            if LLM decides changed=false -> return "no update needed", no pending written
 *   ├ `mem:update-task confirm` -> take from pending -> updateTask (with status passthrough) -> clear pending
 *   └ `mem:update-task cancel`  -> clear pending
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import {
  cancelPendingTaskAction,
  confirmPendingTaskAction,
  updateTaskFromSession,
} from "../../routes/session-task.js";

const DESC_PREVIEW_LEN = 200;

function trimDesc(desc: string | undefined | null): string {
  const text = desc ?? "";
  if (text.length === 0) return "(empty)";
  return text.length > DESC_PREVIEW_LEN ? `${text.slice(0, DESC_PREVIEW_LEN)}...` : text;
}

function parseSubcommand(args: string): "confirm" | "cancel" | null {
  const s = args.trim().toLowerCase();
  if (s === "confirm") return "confirm";
  if (s === "cancel") return "cancel";
  return null;
}

export async function executeUpdateTask(ctx: MemCommandContext): Promise<MemCommandResult> {
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

  // ── confirm ─────────────────────────────────────────────────────────────
  if (subcommand === "confirm") {
    const result = await confirmPendingTaskAction({
      sessionKey: ctx.sessionKey,
      agentSource: ctx.agentSource,
      config: ctx.config,
      spaceId: ctx.spaceId,
    });

    if (result.noPending) {
      return finalize(
        `⚠️ No pending Task update to confirm (it may have timed out or been cancelled). Run \`mem:update-task [addition]\` again.`,
        false,
        { reason: "no_pending" },
      );
    }
    if (!result.success) {
      return finalize(
        `❌ Task update failed: ${result.error ?? "unknown error"}`,
        false,
        { reason: "update_failed", detail: result.error },
      );
    }

    return finalize(
      `✅ Task updated.\n\n` +
        `- **Title**: ${result.title} (cannot change)\n` +
        `- **Status**: ${result.status ?? "running"}\n` +
        `- **New description**: ${trimDesc(result.description)}\n` +
        `- **Task ID**: \`${result.taskId}\``,
      true,
      {
        task_id: result.taskId,
        title: result.title,
        description: result.description,
        status: result.status,
      },
    );
  }

  // ── cancel ──────────────────────────────────────────────────────────────
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
      ? `✅ Pending Task update cancelled.`
      : `ℹ️ There is no pending Task update.`;
    return finalize(msg, true, { cancelled: result.cancelled ?? false });
  }

  // -- First call --------------------------------------------------------

  const directDescription = rawArgs.length > 0 ? rawArgs : undefined;

  if (!directDescription && recentMessages.length === 0) {
    return finalize(
      `⚠️ This request carries no conversation messages; \`mem:update-task\` without an argument needs the recent conversation as context.` +
        `\n\nYou can set it directly: \`mem:update-task <your addition>\`.`,
      false,
      { reason: "no_recent_messages" },
    );
  }

  const result = await updateTaskFromSession({
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
    ...(directDescription ? { directDescription, hint: rawArgs } : {}),
  });

  // Not bound
  if (!result.success && result.error?.includes("no task bound")) {
    return finalize(
      `⚠️ No Task is bound to this session yet. Run \`mem:create-task\` to create one first.`,
      false,
      { reason: "no_task_bound" },
    );
  }

  // Cross-user update: kernel does not support it; the proxy side rejects early and suggests creating a new one
  if (!result.success && result.error === "not_creator") {
    return finalize(
      `❌ Cannot update: you did not create this Task, and editing other users' Tasks is not supported.\n\n` +
        `To create your own Task from this session, use \`mem:create-task\`.`,
      false,
      { reason: "not_creator" },
    );
  }

  // Other errors
  if (!result.success) {
    const detail = result.error ?? "unknown error";
    const hintLine = directDescription
      ? ""
      : "\n\nYou can:\n1. Try again later\n2. Run `mem:update-task <your addition>` to set the new description yourself";
    return finalize(
      `❌ Task update failed: ${detail}${hintLine}`,
      false,
      { reason: "update_failed", detail },
    );
  }

  // LLM decided no update is needed
  if (result.noUpdateNeeded) {
    return finalize(
      `ℹ️ No Task update needed — the recent conversation brought no new progress or scope change.\n\n` +
        `Task ID: \`${result.taskId}\`\n` +
        `Run \`mem:update-task [addition]\` again later to re-check, or pass an argument to force an update.`,
      true,
      { reason: "no_update_needed", task_id: result.taskId },
    );
  }

  // First call: pending preview
  if (result.pending && result.pending.kind === "update") {
    const p = result.pending;
    const statusLine = p.statusSuggestion
      ? `\n- Suggested status: ${p.statusSuggestion}`
      : "";
    return finalize(
      `📝 Update preview for Task "${p.currentTitle ?? p.taskId}":\n\n` +
        `- New description: ${trimDesc(p.draftDescription)}${statusLine}\n\n` +
        `Reply \`mem:update-task confirm\` to confirm or \`mem:update-task cancel\` to cancel.`,
      true,
      {
        reason: "pending",
        pending: {
          kind: "update",
          task_id: p.taskId,
          draft_description: p.draftDescription,
          ...(p.statusSuggestion ? { status_suggestion: p.statusSuggestion } : {}),
          ...(p.currentTitle ? { current_title: p.currentTitle } : {}),
          ...(p.currentStatus ? { current_status: p.currentStatus } : {}),
        },
      },
    );
  }

  // Fallback (theoretically unreachable): return the current state
  return finalize(
    `ℹ️ Task unchanged.\n\nTask ID: \`${result.taskId}\``,
    true,
    { task_id: result.taskId },
  );
}
