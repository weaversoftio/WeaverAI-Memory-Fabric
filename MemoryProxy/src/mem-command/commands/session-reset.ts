/**
 * mem:session-reset - reset the binding of the current session and run the session-init form again mid-conversation.
 *
 * Semantics: whatever the current state is (uninitialized / pending_* / initialized / bypassed),
 * after the command runs it always enters `pending_asset_confirm`, carrying `resetEpoch = Date.now()` +
 * `resetFlow = true`. On the next request, `handleSessionInit` sees state !==
 * initialized and pops up the asset_confirm form, and the user picks Team/Agent/Task again.
 *
 * Cross-node consistency:
 *   - Writes to the store use `store.set` write-through; L1 + L2a (SessionRepo) are persisted synchronously
 *   - Another pod's L1 may still hold the old initialized - `store.getOrRecover` step 1
 *     aligns with L2a using resetEpoch; if L2a.resetEpoch is larger it breaks the L1 short-circuit and takes the new
 *     pending state to pop up the form
 *   - The L2b binding (the "small note" when initialized) is explicitly deleted, so the next `rebuildFromBinding`
 *     doesn't pour the old initialized state straight back
 *
 * Wording: following create-skill's style, only expose terms users understand such as "reset/link/team assets",
 * and avoid internal terms such as status / resetEpoch / binding / pending_asset_confirm.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";

export async function executeSessionReset(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const store = getSessionStore();
  const compositeKey = `${ctx.agentSource}:${ctx.sessionKey}`;

  // Record the old state for observation (instrumentation is added in Commit 4; for now it is only included in the return value data)
  const before = store.get(compositeKey);
  const oldStatus = before?.status ?? "uninitialized";
  const oldBypassed = !!before?.bypassed;

  const resetEpoch = Date.now();
  // Write uninitialized rather than pending_asset_confirm:
  //
  // pending_asset_confirm means "the proxy has already popped up the form and is waiting for the user's answer" - but the next-turn body after reset
  // will not contain a form tool_use/tool_result (because the form hasn't popped up yet).
  // If pending_asset_confirm were written, the next handleSessionInit would enter the "pending_asset_confirm
  // branch" and try to parse a form answer from the user message -> fail -> unrecognized -> bypass ->
  // the command would be wasted.
  //
  // Writing uninitialized makes the next turn take the Case 1 "first time in" branch: re-fetch teams -> pop up the
  // asset_confirm form. Since Commit 2 already removed the isFreshCCConversation gate,
  // it won't be intercepted by the safety net even when there are many messages.
  const nextState: SessionInitState = {
    status: "uninitialized",
    keyId: ctx.sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: ctx.userId,
    resetEpoch,
    resetFlow: true,
  };

  // Fallback bind identity: the handler path normally calls store.getOrRecover(compositeKey, identity, ...) first
  // to complete the bind, but with pre-hook interception the store may not have been bound yet - explicitly bind once more
  // to ensure the L2a write-through of store.set hits the correct namespace.
  store.bind(compositeKey, {
    userId: ctx.userId,
    agentSource: ctx.agentSource,
    sessionId: ctx.sessionKey,
    spaceId: ctx.spaceId,
  });

  await store.set(compositeKey, nextState);

  // Explicitly delete the L2b binding - otherwise on the next request getOrRecover step 3 rebuildFromBinding
  // would pour the old initialized binding straight back, and resetFlow would run idle.
  // store.set already internally does `deleteBinding` for the pending state (it only puts when initialized),
  // but defensively: delete explicitly here, not depending on the implementation details of store.set.
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) {
    try {
      await bindingRepo.deleteBinding(ctx.spaceId, ctx.sessionKey);
    } catch (err) {
      console.warn(
        `[mem-command:session-reset] deleteBinding failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── observability ────────────────────────────────────────────────────────
  // Structured audit log - lets ops precisely catch session-reset
  // events in the dashboard / grep. Fields align with the later session_init_logs completion instrumentation (same session_key /
  // agent_source), so PM/ops can join to see the "reset triggered -> init completed conversion rate".
  // reset_epoch is for cross-node consistency debugging - pod A writes, pod B reads; if the two sides see different
  // reset_epoch you can immediately pinpoint an L2a probeL2a stale problem.
  console.log(
    `[session-reset] session=${compositeKey} space=${ctx.spaceId} user=${ctx.userId} ` +
      `agent_source=${ctx.agentSource} old_status=${oldStatus} old_bypassed=${oldBypassed} ` +
      `new_status=${nextState.status} reset_epoch=${resetEpoch}`,
  );

  const messageText = buildSuccessMessage(oldStatus, oldBypassed);

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: true,
    messageText,
    // Structured data is only visible in logs/the panel, not in user-readable text
    data: {
      old_status: oldStatus,
      old_bypassed: oldBypassed,
      new_status: nextState.status,
      reset_epoch: resetEpoch,
    },
    response,
  };
}

/**
 * Build user-readable text from the old state.
 *
 * old state   wording emphasis
 * uninitialized "a selection will pop up when you continue the conversation"
 * initialized   "binding removed, please choose again"
 * bypassed      "selection entry restored"
 * pending_*     "selection restarted"
 */
function buildSuccessMessage(oldStatus: string, oldBypassed: boolean): string {
  if (oldStatus === "uninitialized") {
    return "✅ Reset. The team asset selection opens when you continue the conversation";
  }
  if (oldBypassed) {
    return "✅ Team asset selection restored; it opens again when you continue the conversation";
  }
  if (oldStatus === "initialized") {
    return "✅ This session's team asset binding was removed; the selection opens again when you continue";
  }
  // pending_*
  return "✅ Team asset selection restarted; it opens when you continue the conversation";
}
