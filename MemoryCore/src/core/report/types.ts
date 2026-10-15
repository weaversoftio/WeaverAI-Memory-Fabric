/**
 * Observability Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the observability contracts for Trace, Log, Metric,
 * LLM Trace, and HTTP Trace Middleware.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper layers (trace.ts, obs-logger.ts, etc.) depend
 *    only on these interfaces — never on OTel SDK, Kafka, or Langfuse directly.
 * 2. **Async-first**: All lifecycle methods return Promises; hot-path methods
 *    (report, send) are synchronous for zero-overhead.
 * 3. **Extensible**: Interface is minimal for v1; implementations can add
 *    backend-specific features without changing the contract.
 * 4. **Safe by default**: All implementations must be error-silent — never
 *    throw exceptions that could affect business logic.
 *
 * Relationship to IStorageBackend (src/core/storage/types.ts):
 *   - IStorageBackend = file storage abstraction (L2/L3 files → local-fs/MongoDB)
 *   - IObservabilityBackend = observability abstraction (Trace/Log/Metric → OTel/Kafka/Langfuse)
 *   Both follow the same pattern: interface + factory + dynamic import for private impl.
 */

import type http from "node:http";

// ============================
// Common Types
// ============================

/** Trace attributes — supports primitive types and null/undefined (which are filtered out) */
export type TraceAttrs = Record<string, string | number | boolean | null | undefined>;

/** Log attributes — primitive types only */
export type LogAttrs = Record<string, string | number | boolean>;

/** Span interface — the minimal subset compatible with @opentelemetry/api Span */
export interface ISpan {
  /** End the Span */
  end(): void;
  /** Set a single attribute */
  setAttribute(key: string, value: string | number | boolean): this;
  /** Set attributes in batch */
  setAttributes(attrs: Record<string, string | number | boolean>): this;
  /** Set the Span status */
  setStatus(status: { code: number; message?: string }): this;
  /** Record an exception */
  recordException(exception: Error | string): void;
  /** Get the Span Context */
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  /** Whether it is recording */
  isRecording(): boolean;
  /** Update the Span name */
  updateName(name: string): this;
  /** Add an event */
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): this;
}

/** SpanProcessor interface — the minimal subset compatible with @opentelemetry/sdk-trace-base SpanProcessor */
export interface ISpanProcessor {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================
// ITraceBackend — Trace abstraction
// ============================

/**
 * Trace backend interface.
 *
 * Implementations:
 * - NoopTraceBackend   — no-op (open-source default)
 * - ConsoleTraceBackend — stdout output (development/debugging)
 * - OTelTraceBackend   — OpenTelemetry (internal: Zhiyan + ClickHouse dual-write)
 */
export interface ITraceBackend {
  /** Backend identifier */
  readonly type: string;

  /**
   * Report a business event (event-as-Span).
   * Internally creates a Span → sets attributes → sets status → End.
   */
  report(event: string, attrs?: TraceAttrs): void;

  /**
   * Create a traditional Span (the caller must call span.end() manually).
   * @param spanName Span name
   * @param kind SpanKind numeric value (INTERNAL=0, SERVER=1, CLIENT=2, PRODUCER=3, CONSUMER=4)
   */
  start(spanName: string, kind?: number): ISpan;

  /** Create a SERVER-kind Span */
  startServer(spanName: string): ISpan;

  /** Create a CLIENT-kind Span */
  startClient(spanName: string): ISpan;
}

// ============================
// ILogBackend — Log abstraction
// ============================

/**
 * Log backend interface.
 *
 * Implementations:
 * - NoopLogBackend    — no-op (open-source default)
 * - ConsoleLogBackend — stdout output (development/debugging)
 * - OTelLogBackend    — OpenTelemetry Logs API (internal: Zhiyan + ClickHouse dual-write)
 */
export interface ILogBackend {
  /** Backend identifier */
  readonly type: string;

  /** INFO level log */
  info(eventName: string, attrs?: LogAttrs): void;

  /** WARN level log */
  warn(eventName: string, attrs?: LogAttrs): void;

  /** ERROR level log */
  error(eventName: string, attrs?: LogAttrs, error?: Error): void;

  /** DEBUG level log */
  debug?(eventName: string, attrs?: LogAttrs): void;
}

// ============================
// IMetricBackend — Metric abstraction
// ============================

/** Metric message structure */
export interface MetricMessage {
  /** Metric name */
  metric: string;
  /** Instance ID (also used as the Kafka key) */
  instanceId: string;
  /** Raw value */
  value: number;
  /** Unix seconds (UTC) when the event happened; defaults to the current time if omitted */
  timestamp?: number;
  /** Source service */
  source?: string;
  /**
   * Associated OTel Trace ID, used for Metric → Trace lookup.
   * Injected automatically by metricProducer.send() from the current active span; callers usually do not need to pass it.
   * Once stored in ClickHouse, the online evaluation service can use this field to locate the full Trace of a specific request.
   */
  traceId?: string;
}

/** Kafka Metric config */
export interface MetricBackendConfig {
  /** Kafka Broker list */
  brokers: string[];
  /** Topic name (default: "memory_monitor") */
  topic?: string;
  /** Whether enabled (default: false) */
  enabled?: boolean;
}

/**
 * Metric backend interface.
 *
 * Implementations:
 * - NoopMetricBackend  — no-op (open-source default)
 * - ConsoleMetricBackend — stdout output (development/debugging)
 * - KafkaMetricBackend — Kafka Producer (internal: memory-monitor consumes → Barad + ClickHouse)
 */
export interface IMetricBackend {
  /** Backend identifier */
  readonly type: string;

  /** Send one metric message (synchronous, non-blocking) */
  send(msg: MetricMessage): void;

  /** Initialize the backend (asynchronous) */
  initialize(config: MetricBackendConfig): Promise<void>;

  /** Graceful shutdown */
  destroy(): Promise<void>;
}

// ============================
// ILLMTraceBackend — AI/LLM Trace abstraction
// ============================

/** Langfuse config */
export interface LLMTraceConfig {
  /** Whether enabled */
  enabled: boolean;
  /** Langfuse instance address */
  host?: string;
  /** Langfuse public key */
  publicKey?: string;
  /** Langfuse secret key */
  secretKey?: string;
}

/**
 * LLM Trace backend interface.
 *
 * Implementations:
 * - NoopLLMTraceBackend     — no-op (open-source default)
 * - ConsoleLLMTraceBackend  — stdout output (development/debugging)
 * - LangfuseLLMTraceBackend — Langfuse (internal: filters AI Spans and reports them to Langfuse)
 */
export interface ILLMTraceBackend {
  /** Backend identifier */
  readonly type: string;

  /**
   * Create a SpanProcessor instance.
   * The returned processor is registered with the OTel TracerProvider
   * to filter and report AI/LLM-related Spans.
   */
  createSpanProcessor(): ISpanProcessor | null;

  /** Force-flush pending LLM Trace data */
  flush(): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

// ============================
// ITraceMiddleware — HTTP Trace middleware abstraction
// ============================

/**
 * HTTP Trace middleware interface.
 *
 * Implementations:
 * - NoopTraceMiddleware — pass-through (open-source default)
 * - ConsoleTraceMiddleware — stdout output (development/debugging)
 * - OTelTraceMiddleware — OpenTelemetry (internal: creates SERVER Span + Context propagation)
 */
export interface ITraceMiddleware {
  /** Backend identifier */
  readonly type: string;

  /**
   * Wrap an HTTP request handler and add Trace instrumentation.
   * Restores the upstream Trace Context from the traceparent header and creates a SERVER Span.
   */
  wrapWithTrace(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: () => Promise<void>,
  ): Promise<void>;

  /**
   * Create a child Span (used inside a business handler).
   * The caller must call span.end() manually.
   */
  startChildSpan(
    name: string,
    attrs?: Record<string, string | number | boolean>,
  ): ISpan;

  /**
   * Run a function in a Span context, automatically creating a child Span.
   */
  withSpan<T>(
    name: string,
    attrs: Record<string, string | number | boolean>,
    fn: (span: ISpan) => Promise<T>,
  ): Promise<T>;
}

// ============================
// ITracePropagation — Trace Context propagation abstraction
// ============================

/**
 * Interface for propagating Trace Context across async boundaries.
 * Used to serialize/deserialize the OTel Trace Context in async tasks.
 */
export interface ITracePropagation {
  /**
   * Serialize the current Trace Context into a plain object.
   * The returned object can be spread into TaskPayload.data.
   */
  serializeTraceContext(): Record<string, string | number>;

  /**
   * Deserialize and restore the Trace Context from TaskPayload.data.
   * Returns parentContext and parentSpanContext.
   */
  deserializeTraceContext(data?: Record<string, unknown>): {
    parentContext: unknown;
    parentSpanContext: { traceId: string; spanId: string; traceFlags: number; isRemote: boolean } | null;
  };
}

// ============================
// IObservabilityBackend — aggregate interface
// ============================

/**
 * Observability backend aggregate interface — contains all sub-backends.
 *
 * Created by the factory function createObservabilityBackend(config),
 * and the global singleton is exposed to the facade modules.
 */
export interface IObservabilityBackend {
  /** Backend type identifier */
  readonly type: "noop" | "console" | "internal" | string;

  /** Trace backend */
  readonly trace: ITraceBackend;

  /** Log backend */
  readonly log: ILogBackend;

  /** Metric backend */
  readonly metric: IMetricBackend;

  /** LLM Trace backend */
  readonly llmTrace: ILLMTraceBackend;

  /** HTTP Trace middleware */
  readonly traceMiddleware: ITraceMiddleware;

  /** Trace Context propagation */
  readonly tracePropagation: ITracePropagation;

  /** Initialize all sub-backends */
  initialize(config: ObservabilityConfig): Promise<void>;

  /** Gracefully shut down all sub-backends */
  shutdown(): Promise<void>;
}

// ============================
// Configuration
// ============================

/** OTel config */
export interface OTelConfig {
  /** Whether enabled */
  enabled: boolean;
  /** OTel Collector endpoint */
  endpoint?: string;
  /** Protocol (grpc | http | http/protobuf) */
  protocol?: "grpc" | "http" | "http/protobuf";
  /** Service name */
  serviceName?: string;
  /** Tenant ID */
  tenantId?: string;
}

/** ClickHouse config */
export interface ClickHouseConfig {
  /** Whether enabled */
  enabled: boolean;
  /** ClickHouse HTTP endpoint */
  endpoint?: string;
  /** Username */
  username?: string;
  /** Password */
  password?: string;
  /** Database name */
  database?: string;
}

/**
 * Overall observability config.
 *
 * Backend type notes:
 * - "noop"     — no-op, zero overhead (default, used when not configured)
 * - "console"  — outputs to stdout, for development and debugging
 * - "otlp"     — standard OTLP protocol backend (recommended for open-source users)
 *                configure otel.endpoint to report Trace/Log/Metric to any OTLP-capable backend
 *                (e.g. ClickHouse, Jaeger, Grafana Tempo/Loki/Mimir, SigNoz, OTel Collector)
 * - "internal" — internal private module (brought in via git submodule; Zhiyan + Kafka + Langfuse)
 */
export interface ObservabilityConfig {
  /** Backend type: noop | console | otlp | internal */
  type: "noop" | "console" | "otlp" | "internal" | string;

  /**
   * OTel config (used by the otlp and internal modes).
   *
   * Open-source users on the "otlp" mode only need to configure:
   *   otel: {
   *     enabled: true,
   *     endpoint: "http://localhost:4318",  // your OTLP backend address
   *     serviceName: "my-memory-service",   // optional, default "wamf-memory"
   *   }
   */
  otel?: OTelConfig;

  /** ClickHouse config (used by the internal mode) */
  clickhouse?: ClickHouseConfig;

  /** Kafka Metric config (used by the internal mode) */
  kafka?: MetricBackendConfig;

  /** Langfuse LLM Trace config (used by the internal mode) */
  langfuse?: LLMTraceConfig;
}

// ============================
// Logger Interface (for internal use)
// ============================

/** Minimal logging interface used inside the observability module */
export interface ObservabilityLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
