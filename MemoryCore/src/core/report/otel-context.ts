/**
 * OTel context helpers.
 *
 * Background (why it is needed):
 *   The skill extraction worker's `runLoop()` is **lazily started** inside some HTTP request handler
 *   (`resolveConversationAdd` → `wireConversationAdd` → `worker.start()`).
 *   OTel propagates context with AsyncLocalStorageContextManager - a `runLoop()` that **never exits**
 *   permanently inherits the active span "at the moment of startup" (that request's span),
 *   so every later LLM `generateText` becomes a child span of that request's trace and is
 *   merged into one trace by Langfuse (tags spanning several agents, a messy sessionId).
 *
 *   `runInRootContext` runs fn in the OTel ROOT_CONTEXT, cutting off this parasitism,
 *   so spans created inside fn (e.g. ai.generateText) become independent roots (each with its own traceId).
 *
 * Defensively loads @opentelemetry/api: when the package is missing (open-source / slim deployments) it degrades to running fn directly,
 * semantically equivalent and without errors. The loading approach mirrors otel-sdk-init.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _context: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rootContext: any = null;

try {
  const api = await import("@opentelemetry/api");
  _context = api.context;
  _rootContext = api.ROOT_CONTEXT;
} catch {
  // @opentelemetry/api unavailable → stays null; runInRootContext degrades to running fn directly
}

/**
 * Run fn in the OTel ROOT_CONTEXT, cutting off inheritance of the call site's active span.
 *
 * Typical use: wrap the startup of a background loop that never exits, so the loop does not keep carrying the "startup-time" trace
 * context forever. When otel is unavailable, fn runs directly (no context isolation, but equivalent behavior).
 */
export function runInRootContext<T>(fn: () => T): T {
  if (_context && _rootContext) {
    return _context.with(_rootContext, fn) as T;
  }
  return fn();
}
