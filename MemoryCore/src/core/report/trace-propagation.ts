/**
 * Trace Context propagation across async boundaries (facade layer)
 *
 * Serializes/deserializes the OTel Trace Context in async tasks,
 * enabling cross-async trace correlation from HTTP request → Pipeline Worker.
 *
 * Usage:
 *   // On enqueue: serialize the current Trace Context into TaskPayload.data
 *   const traceCtx = serializeTraceContext();
 *   task.data = { ...task.data, ...traceCtx };
 *
 *   // On consume: deserialize and restore the Trace Context from TaskPayload.data
 *   const parentCtx = deserializeTraceContext(task.data);
 *   // Create a CONSUMER Span within parentCtx
 *
 * The public API signatures are unchanged; callers need no changes.
 */

import { getObservabilityBackend } from "./factory.js";

/**
 * Serialize the current Trace Context into a plain object.
 * The returned object can be spread directly into TaskPayload.data.
 *
 * Returns an empty object if there is no valid Span Context.
 */
export function serializeTraceContext(): Record<string, string | number> {
  try {
    return getObservabilityBackend().tracePropagation.serializeTraceContext();
  } catch {
    return {};
  }
}

/**
 * Deserialize and restore the Trace Context from TaskPayload.data.
 *
 * Returns an OTel Context that can be used to create a follow-from linked CONSUMER Span.
 * Returns ROOT_CONTEXT if data has no trace information.
 */
export function deserializeTraceContext(
  data?: Record<string, unknown>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): { parentContext: any; parentSpanContext: any | null } {
  try {
    return getObservabilityBackend().tracePropagation.deserializeTraceContext(data);
  } catch {
    return { parentContext: {}, parentSpanContext: null };
  }
}
