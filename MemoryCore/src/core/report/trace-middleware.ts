/**
 * Core HTTP Trace middleware — non-intrusive Trace instrumentation (facade layer)
 *
 * Creates a SERVER-kind entry Span (core.request) for every HTTP request,
 * restores the upstream Trace Context from the traceparent header, enabling cross-service trace correlation.
 *
 * Usage (in server.ts):
 *   import { wrapWithTrace } from "../core/report/trace-middleware.js";
 *   // wrap handleRequest when creating the server
 *   this.server = http.createServer((req, res) => wrapWithTrace(req, res, () => this.handleRequest(req, res)));
 *
 * Does not modify any business code; a pure observability component.
 * The public API signatures are unchanged; callers need no changes.
 */

import http from "node:http";
import { getObservabilityBackend } from "./factory.js";
import type { ISpan } from "./types.js";

// Re-export the Span type (backward compatible)
export type { Span } from "@opentelemetry/api";

/**
 * Wrap an HTTP request handler and add Trace instrumentation.
 *
 * @param req HTTP request
 * @param res HTTP response
 * @param handler the original request handler
 */
export async function wrapWithTrace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    return await getObservabilityBackend().traceMiddleware.wrapWithTrace(req, res, handler);
  } catch (err) {
    // If the exception was thrown by the handler itself, it must be re-thrown
    throw err;
  }
}

/** Noop Span — a safe substitute when the backend is unavailable */
const noopSpan: ISpan = {
  end() {},
  setAttribute() { return this; },
  setAttributes() { return this; },
  setStatus() { return this; },
  recordException() {},
  spanContext() { return { traceId: "", spanId: "", traceFlags: 0 }; },
  isRecording() { return false; },
  updateName() { return this; },
  addEvent() { return this; },
};

/**
 * Create a child Span (for finer-grained Spans inside a business handler).
 *
 * @param name Span name (e.g. "core.store.write")
 * @param attrs Span attributes
 * @returns a Span instance; the caller must call span.end() manually
 */
export function startChildSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  try {
    return getObservabilityBackend().traceMiddleware.startChildSpan(name, attrs);
  } catch {
    return noopSpan;
  }
}

/**
 * Run a function in the current Span context and automatically create a child Span.
 *
 * @param name Span name
 * @param attrs Span attributes
 * @param fn the function to run
 * @returns the return value of fn
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (span: any) => Promise<T>,
): Promise<T> {
  try {
    return await getObservabilityBackend().traceMiddleware.withSpan(name, attrs, fn);
  } catch (err) {
    // If the exception was thrown by fn itself, it must be re-thrown
    throw err;
  }
}