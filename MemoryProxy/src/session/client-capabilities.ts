/**
 * Client Capabilities Detection.
 *
 * Purpose: different clients support the "proxy initiates a fake ask tool_call" differently.
 *   - older workbuddy: body.tools contains `AskUserQuestion` -> supports card forms (tool_calls SSE)
 *   - newer workbuddy: body.tools **does not contain** `AskUserQuestion` -> no card support, must degrade to a plain-text reply
 *   - other clients: this module makes no judgment (keeps the original path)
 *
 * Detection signals: agentSource + body.tools[]. **Computed live on every request**, not cached,
 * so if the next request under the same sessionKey carries the ask tool it automatically switches back to card mode.
 *
 * Scope (current iteration): only decide whether workbuddy has the `AskUserQuestion` tool.
 * All other clients always get `askUserQuestion: true` (original logic), to avoid breaking the existing branches of dsh / codebuddy /
 * claude-code / codex / opencode / hermes / openclaw.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Tool name WorkBuddy uses to pop up card forms. Keep consistent with TOOL_NAME in workbuddy/form.ts. */
export const WB_ASK_TOOL_NAME = "AskUserQuestion";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  /**
   * Whether the client supports the proxy initiating an "ask the user" card tool call.
   *
   * - `true`  -> use the existing card mode (tool_calls SSE + form rendering)
   * - `false` -> use text mode (content chunk + markdown rendering + plain-text parsing)
   *
   * Currently only workbuddy returns false (when body.tools does not contain AskUserQuestion);
   * all other clients always return true (keeping existing behaviour).
   */
  askUserQuestion: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Check whether body.tools[] contains a tool with the given name.
 *
 * Compatible with two shapes:
 *   - OpenAI:    `{ type: "function", function: { name: "..." } }`
 *   - flat:      `{ name: "..." }`
 *
 * Returns false when tools is an empty array / not an array / undefined.
 */
function toolsContain(tools: unknown, name: string): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const fn = (t as { function?: { name?: string } }).function;
    const flatName = (t as { name?: string }).name;
    const n = fn?.name ?? flatName;
    return n === name;
  });
}

// ── Detection ──────────────────────────────────────────────────────────────────

/**
 * Detect the client capabilities of the current request.
 *
 * @param agentSource - client type, e.g. "workbuddy" / "codebuddy" / "dsh" / ...
 * @param body        - raw request body (including tools[])
 * @returns capability flags
 */
export function detectClientCapabilities(
  agentSource: string,
  body: unknown,
): ClientCapabilities {
  // Only workbuddy gets capability detection; all other clients take the original path.
  if (agentSource !== "workbuddy") {
    return { askUserQuestion: true };
  }

  // workbuddy: check whether body.tools[] contains AskUserQuestion.
  // - tools not an array / empty array / missing -> treated as **no capability** (this is the shape of newer WB)
  //   This is more conservative: better to use text mode (worse experience but works),
  //   than card mode (the client does not recognise the tool -> hangs).
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  const hasAskTool = toolsContain(tools, WB_ASK_TOOL_NAME);
  return { askUserQuestion: hasAskTool };
}
