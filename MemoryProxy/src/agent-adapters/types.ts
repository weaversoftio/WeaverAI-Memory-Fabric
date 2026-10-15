/**
 * Agent Adapter - an abstraction layer that adapts to the differing behavior of
 * the CC client / CodeBuddy / other IDE clients.
 *
 * Background: different clients put different things into requests:
 *   - Claude Code (anthropic protocol): user content is a multi-text-block array, with
 *     metadata such as <system-reminder> / <local-command-*> first, and only the last text block
 *     is the user's input; fork-type requests (SUGGESTION/RECAP/COMPACT) differ from the main conversation in cache_control
 *     marker position (n-2 vs n-1).
 *   - CodeBuddy (openai protocol): user content is often a string, possibly mixed with CB-internal
 *     tags - a structure very different from CC.
 *   - Others (cursor / windsurf / custom SDKs): not studied.
 *
 * The proxy has three places that need per-client adaptation:
 *   1. Classify the request category (main / fork / sidequery) - decides which path later stages take
 *   2. Extract "the text the user actually typed" from the user message content - used by mem command recognition /
 *      skill buffer normalization
 *
 * The common capabilities (skill_buffer writes, L0 memory, mem interception) must be open to all clients;
 * only the **rules for getting user input** and the **classification rules** are adapted per agent.
 */

export type AgentKind = "claude-code" | "codebuddy" | "codex" | "workbuddy" | "dsh" | "opencode" | "pi" | "unknown";

export type RequestKind = "main" | "fork" | "sidequery" | "auxiliary";

export interface AgentAdapter {
  /** Client type identifier, mapped from the URL prefix. */
  readonly agentKind: AgentKind;

  /**
   * Classify the request category. Used by the handler to decide whether later stages bypass business side effects such as injection / mem interception /
   * L0 / skill buffer.
   *
   * - claude-code: three-way split by cache_control marker position + tools/thinking fallback
   *   (see docs/design/2026-07-30-cc-request-routing-plan.md)
   * - codebuddy / unknown: always returns "main" - the classification rules for this client are not studied, so conservatively take
   *   the old path equivalent to the status quo (no request splitting)
   */
  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind;

  /**
   * Extract "the text the user actually typed" from the content of a user message.
   *
   * - claude-code: take the last type:"text" block (skipping the CC-internal metadata such as <system-reminder> before it,
   *   and skipping other block types such as tool_result / image / thinking)
   * - codebuddy / unknown: conservatively use the old "convert content to string" logic, equivalent to the status quo
   *
   * Returning null means "there is no user-typed text in the content" (e.g. it is all tool_result).
   */
  extractUserText(content: unknown): string | null;
}
