/**
 * Kafka Metric Producer — core component (facade layer)
 *
 * Sends monitoring metric messages asynchronously, handled by the IMetricBackend backend.
 * Internal environment: Kafka → memory-monitor consumes and aggregates, then reports to Barad + ClickHouse.
 * Open-source environment: Noop or Console output.
 *
 * Design notes:
 *   - asynchronous sending, does not block business requests
 *   - send failures are silently ignored (no retry, no blocking)
 *   - does not modify any business code; a pure observability component
 *
 * Usage:
 *   import { metricProducer } from "../core/report/kafka-metric-producer.js";
 *   metricProducer.send({ metric: "l1_extraction_credit_rate", instanceId: "mem-abc", value: 150 });
 *
 * The public API signatures are unchanged; callers need no changes.
 */

import { getObservabilityBackend } from "./factory.js";
import type { MetricMessage, MetricBackendConfig } from "./types.js";

// Re-export types (backward compatible)
export type { MetricMessage } from "./types.js";
export type KafkaMetricConfig = MetricBackendConfig;

// ============================
// CRC32 Partition computation (export kept for private modules)
// ============================

import CRC32 from "crc-32";

/**
 * Compute the Partition number using CRC32 IEEE.
 * Matches the Go side `crc32.ChecksumIEEE([]byte(instanceId)) % totalPartitions`.
 *
 * Note: the crc-32 npm package returns a signed 32-bit integer, which must be converted to unsigned.
 */
export function calculatePartition(instanceId: string, totalPartitions: number): number {
  if (totalPartitions <= 0) return 0;
  // crc-32 returns a signed int32; convert to unsigned uint32
  const checksum = CRC32.str(instanceId) >>> 0;
  return checksum % totalPartitions;
}

// ============================
// Metric Producer facade
// ============================

/**
 * Metric Producer facade.
 *
 * Keeps the same public API as the original KafkaMetricProducer:
 * - send(msg) — send one metric message
 * - initialize(config) — initialize the backend
 * - destroy() — graceful shutdown
 *
 * Internally delegates to IMetricBackend (obtained via the global singleton).
 */
class MetricProducerFacade {
  /**
   * Send one monitoring message asynchronously.
   * Silently ignored if the backend is not initialized or already closed.
   *
   * Auto-injects traceId: extracts the traceId from the current OTel active span
   * and injects it into the MetricMessage (only when the caller did not pass it manually).
   * If injection fails, silently degrades to an empty string without affecting metric sending.
   */
  send(msg: MetricMessage): void {
    try {
      // Auto-inject traceId (not overridden when the caller passed it manually)
      if (msg.traceId === undefined) {
        try {
          const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
          msg = { ...msg, traceId: (ctx as Record<string, unknown>)._traceId as string ?? "" };
        } catch {
          msg = { ...msg, traceId: "" };
        }
      }
      getObservabilityBackend().metric.send(msg);
    } catch {
      // Silent failure
    }
  }

  /**
   * Initialize the Metric backend.
   * The actual initialization is done uniformly by initObservabilityBackend();
   * this method is kept for backward compatibility.
   */
  async initialize(config: MetricBackendConfig): Promise<void> {
    try {
      await getObservabilityBackend().metric.initialize(config);
    } catch {
      // Silent failure
    }
  }

  /**
   * Graceful shutdown.
   */
  async destroy(): Promise<void> {
    try {
      await getObservabilityBackend().metric.destroy();
    } catch {
      // Silent failure
    }
  }
}

/** Global singleton */
export const metricProducer = new MetricProducerFacade();