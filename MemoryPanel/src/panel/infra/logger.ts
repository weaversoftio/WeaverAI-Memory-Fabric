/**
 * Logging port (abstract). Business/infrastructure code depends only on this interface, not on a concrete logging library.
 * Swapping the implementation (console / pino / shipping to a log platform) only changes the adapter + container,
 * see docs/architecture/06-logging.md.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields, emitted together with a log entry. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /**
   * Derive a child logger with fixed fields (e.g. reqId / userId);
   * every log entry from that logger then carries these fields automatically, making it easy to correlate one request.
   */
  child(bindings: LogFields): Logger;
}
