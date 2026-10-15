/**
 * Recall Metric Reporter — recall stage metric reporting.
 *
 * After recall completes, non-intrusively reports the following metrics to Kafka:
 *   - recall_hit_count   : number of L1 memories hit by this recall
 *   - recall_top_score   : highest similarity score among the recall results (store hybrid score)
 *   - recall_latency_ms  : total recall time (ms, integer)
 *
 * Design principles (fully isomorphic with MetricTrackingRunner):
 *   1. After recall completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the recall result is unaffected
 *   3. No reporting when recall fails (hasError=true)
 *   4. No reporting when there is no instanceId
 *   5. When 0 results are recalled, hit_count=0 + latency are still reported, but not top_score
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Strategy Encoding (numeric for ClickHouse storage)
// ============================

const STRATEGY_CODE: Record<string, number> = {
  skipped: 0,
  keyword: 1,
  embedding: 2,
  hybrid: 3,
};

// ============================
// Input Interface
// ============================

export interface RecallMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Recalled L1 memory list (with scores) */
  recalledL1Memories: Array<{ content: string; score: number; type: string }> | undefined;
  /** Recall strategy in effect */
  recallStrategy: string;
  /** Total recall time (ms) */
  recallLatencyMs: number;
  /** Whether recall failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report the recall stage metrics to Kafka.
 *
 * Silent and safe: any exception is swallowed by try-catch and never thrown outward.
 * When to call: after performAutoRecallCore returns, before the result is passed to the business.
 */
export function reportRecallMetrics(input: RecallMetricInput): void {
  try {
    // Guard: no reporting on failure
    if (input.hasError) return;

    // Guard: no reporting without instanceId
    if (!input.instanceId) return;

    const memories = input.recalledL1Memories ?? [];
    const hitCount = memories.length;
    const latencyMs = Math.round(input.recallLatencyMs);

    // 1. Report recall_hit_count (including the 0-result case)
    try {
      metricProducer.send({
        metric: "recall_hit_count",
        instanceId: input.instanceId,
        value: hitCount,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 2. Report recall_top_score (only when there are memories)
    if (hitCount > 0) {
      try {
        const topScore = Math.max(...memories.map((m) => m.score));
        metricProducer.send({
          metric: "recall_top_score",
          instanceId: input.instanceId,
          value: topScore,
          source: "core",
        });
      } catch {
        // Silent failure
      }
    }

    // 3. Report recall_latency_ms
    try {
      metricProducer.send({
        metric: "recall_latency_ms",
        instanceId: input.instanceId,
        value: latencyMs,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 4. Report recall_strategy (numeric encoding: skipped=0, keyword=1, embedding=2, hybrid=3, unknown=-1)
    try {
      const strategyCode = STRATEGY_CODE[input.recallStrategy] ?? -1;
      metricProducer.send({
        metric: "recall_strategy",
        instanceId: input.instanceId,
        value: strategyCode,
        source: "core",
      });
    } catch {
      // Silent failure
    }
  } catch {
    // Outermost catch — never throw outward
  }
}
