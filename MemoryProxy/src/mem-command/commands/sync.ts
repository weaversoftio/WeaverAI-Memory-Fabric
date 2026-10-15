/**
 * mem:sync - refresh all injection caches of the current session
 *
 * Underlying actions:
 *   - re-fetch Agent / Task detail and overwrite it in SessionStore (description, prompt and goal are all updated)
 *   - re-run every hook that declares a session_init / hybrid cache strategy (Skill / memory /
 *     Knowledge / fixed assets, etc.) and putMany the new blocks into HookCacheRepo (ProxyStorage)
 *
 * User-facing text only talks about concepts users understand ("assets / descriptions"); it does not expose internal terms such as injector ids, hook names,
 * archive_key.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { refreshSessionCache, type RefreshResult } from "../../routes/session-refresh.js";

function buildSuccessMessage(result: RefreshResult): string {
  const parts: string[] = [];
  parts.push("Skill / memory / Knowledge assets");
  if (result.agentRefreshed || result.taskRefreshed) {
    parts.push("Task & Agent descriptions");
  }
  const scope = parts.join(", ");
  return `✅ All asset injections refreshed (${scope}) in ${result.tookMs}ms`;
}

export async function executeSync(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // When not bound, skip refreshSessionCache (it would expose the session key to the user)
  if (!ctx.sessionInfo || Object.keys(ctx.sessionInfo).length === 0) {
    const messageText = "⚠️ This session has no team assets bound, so there is nothing to sync. Use `mem:session-reset` to choose a Team/Agent first.";
    return {
      success: false,
      messageText,
      response: buildMemResponse(messageText, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  const result = await refreshSessionCache({
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    config: ctx.config,
    spaceId: ctx.spaceId,
    callerUserKey: ctx.apiKey,
  });

  const messageText = result.success
    ? buildSuccessMessage(result)
    : `❌ Asset refresh failed: ${result.error ?? "unknown error"}`;

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: result.success,
    messageText,
    // The detailed hookId list / duration is kept in the structured data for the panel / logs.
    data: result.success
      ? {
          refreshed: result.refreshed,
          skipped: result.skipped,
          agent_refreshed: result.agentRefreshed,
          task_refreshed: result.taskRefreshed,
          took_ms: result.tookMs,
        }
      : undefined,
    response,
  };
}
