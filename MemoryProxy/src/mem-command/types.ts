/**
 * mem-command module type definitions
 */

import type { ProxyConfig, MemCommandConfig } from "../types.js";

/**
 * Recent conversation message snippet. Consumed by task-draft-generator.
 * Currently only role + content are needed, without tool_calls / attachment, to stay minimal.
 */
export interface MemCommandMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface MemCommandContext {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: Record<string, unknown>;
  protocol: "anthropic" | "openai" | "responses";
  stream: boolean;
  /**
   * Model name of the client's current request (the real model_id after body.model is normalized by resolveModelId).
   * Plan D: the taskDraft LLM follows the main model and no longer depends on config.memCommand.taskDraft.
   */
  model?: string;
  /**
   * Per-agent resolved upstream base url (without the specific endpoint).
   * Plan D: taskDraft reuses the same upstream as the main path, with rules consistent with main-path forwarding:
   *   config.upstream.agents?.[agent]?.url ?? config.upstream.url
   */
  upstreamUrl?: string;
  /**
   * **API protocol family** of the taskDraft LLM upstream (decides the request shape, different in meaning from this ctx.protocol).
   *
   * WARNING: distinguish from the `protocol` field:
   *   - `protocol` (below, the existing old field in this ctx): **response rendering protocol** -- decides
   *     which SSE skeleton `buildMemResponse` uses to emit the mem command result to the client (corresponds one to one to the client-side
   *     protocol, e.g. anthropic/openai/responses).
   *   - `upstreamProtocol` (this field): **which protocol the taskDraft LLM request uses toward the upstream** --
   *     decides whether attemptDraftOnce hits /v1/messages, /chat/completions or /responses.
   *     It depends on the upstream endpoint the client's main path really uses, **not necessarily equal to the response protocol**.
   *
   * Typical case: the WorkBuddy client renders responses with the Responses SSE skeleton (protocol="responses"),
   * but the main-path upstream is actually OpenAI chat/completions (upstreamProtocol="openai").
   *
   * When omitted, task-draft-generator treats it as "openai".
   */
  upstreamProtocol?: "openai" | "anthropic" | "responses";
  /** Command arguments (e.g. the prompt of create-skill / create-task) */
  args: string;
  /** Whether the request enabled extended thinking (Anthropic only) */
  thinking?: boolean;
  /**
   * Recent conversation messages of the current request (used by task-draft-generator to generate a draft).
   *
   * - CC/CB use chat/completions: directly body.messages[]
   * - Codex/WorkBuddy use the Responses API: currently an empty array is passed (body.input parsing to be added during stage 5 integration)
   *
   * Treated as an empty array when not provided; the task command family will return a "no recent messages" error.
   */
  bodyMessages?: MemCommandMessage[];
}

/**
 * Supported mem: command names -- a strongly typed union, used by index.ts for dispatch / narrowing in commands/*.
 * Strings not listed fall into the "unknown command" fallback of executeMemCommand.
 */
export type MemCommandName =
  | "help"
  | "sync"
  | "create-skill"
  | "create-task"
  | "update-task";

export interface MemCommandResult {
  success: boolean;
  /** User-readable result text (written to L0 / shown to the user) */
  messageText: string;
  /** Structured data (optional) */
  data?: Record<string, unknown>;
  /** The constructed HTTP Response (already faked in the protocol format) */
  response: Response;
}

export type { MemCommandConfig };
