/**
 * Model intent (tool_use) telemetry helper -- shared by handler.ts and anthropicHandler.ts.
 *
 * Design: after the SSE stream closes, convert all tool_use entries in this turn's toolCallAccumulators in one go
 *      into kind='model_intent' telemetry entries and send them out.
 *
 * Hard constraints (section 7.-1):
 *   - return void synchronously, never throw
 *   - an exception from the sink on a single entry does not affect the others
 *   - empty intents / empty name are skipped directly
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

/** Minimal description of one model tool-call intent. */
export interface ModelIntent {
  /** function.name / tool_use.name */
  name: string;
  /** function.arguments / JSON.stringify(tool_use.input) -- original text, not truncated */
  arguments: string;
}

export interface ModelIntentInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  agentSource: string;
  intents: ModelIntent[];
}

/**
 * Send one model_intent telemetry entry for every tool_use accumulated in the current turn, in one go.
 * An empty array or empty name is skipped directly; an exception on one entry does not affect later ones.
 */
export function emitModelIntentTelemetry(
  input: ModelIntentInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    if (!input.intents || input.intents.length === 0) return;
    const ts = new Date().toISOString();
    for (const intent of input.intents) {
      if (!intent || !intent.name) continue; // empty name -> partial SSE frame, skip
      try {
        sink({
          timestamp: ts,
          sessionKey: input.sessionKey,
          turnSeq: input.turnSeq,
          spaceId: input.spaceId,
          userId: input.userId,
          agentSource: input.agentSource,
          kind: "model_intent",
          bridgeSource: "",
          initiatedTool: intent.name,
          executedEndpoint: "",
          requestBody: intent.arguments ?? "",
          upstreamStatus: 0,
          elapsedMs: 0,
        });
      } catch {
        // Single-entry failure -> continue with the next; telemetry must never block business logic
      }
    }
  } catch {
    // Top-level fallback
  }
}
