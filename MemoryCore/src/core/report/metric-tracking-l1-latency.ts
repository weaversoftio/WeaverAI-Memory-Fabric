/**
 * L1 Latency Metric Reporter — L1 extraction stage latency metric reporting.
 *
 * After L1 extraction completes, non-intrusively reports the following metrics to Kafka:
 *   - l1_extraction_latency_ms : total end-to-end L1 extraction time (ms)
 *   - l1_dedup_latency_ms     : dedup stage time (ms)
 *
 * Design principles (fully isomorphic with metric-tracking-recall):
 *   1. After extraction completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the extraction result is unaffected
 *   3. No reporting when extraction fails (hasError=true)
 *   4. No reporting when there is no instanceId
 *   5. dedupLatencyMs null means the dedup path was not taken; no dedup metric is reported
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L1LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Total end-to-end L1 extraction time (ms) */
  extractionLatencyMs: number;
  /** Dedup stage time (ms). null means the dedup path was not taken */
  dedupLatencyMs: number | null;
  /** Whether extraction failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report the L1 extraction stage latency metrics to Kafka.
 *
 * Silent and safe: any exception is swallowed by try-catch and never thrown outward.
 */
export function reportL1LatencyMetrics(input: L1LatencyMetricInput): void {
  try {
    // Guard: no reporting on failure
    if (input.hasError) return;

    // Guard: no reporting without instanceId
    if (!input.instanceId) return;

    // 1. Report l1_extraction_latency_ms
    try {
      metricProducer.send({
        metric: "l1_extraction_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.extractionLatencyMs),
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 2. Report l1_dedup_latency_ms (only when the dedup path was taken)
    if (input.dedupLatencyMs !== null) {
      try {
        metricProducer.send({
          metric: "l1_dedup_latency_ms",
          instanceId: input.instanceId,
          value: Math.round(input.dedupLatencyMs),
          source: "core",
        });
      } catch {
        // Silent failure
      }
    }
  } catch {
    // Outermost catch — never throw outward
  }
}
