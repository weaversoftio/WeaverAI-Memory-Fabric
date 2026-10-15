/**
 * L2 Scene Extraction Metric Reporter — L2 scene extraction metric reporting.
 *
 * After L2 scene extraction completes, non-intrusively reports the following metrics to Kafka:
 *   - l2_extraction_latency_ms  : total end-to-end L2 scene extraction time (ms)
 *   - l2_llm_duration_ms       : L2 LLM call duration (ms)
 *   - l2_scene_count_before    : number of scenes before extraction
 *   - l2_scene_count_after     : number of scenes after extraction
 *   - l2_scenes_created        : number of scenes created this time
 *   - l2_scenes_updated        : number of scenes updated this time
 *   - l2_scenes_deleted        : number of scenes deleted this time
 *
 * Trace correlation:
 *   All metrics automatically get the traceId of the current active span via metricProducer.send().
 *   L2 runs inside TracedTaskExecutor.executeL2() → withSpan("core.l2.extraction"),
 *   whose child spans include the ai.generateText / gen_ai.chat spans produced automatically by the Vercel AI SDK,
 *   carrying the gen_ai.request.model attribute. Through the traceId you can look up:
 *     - which model was used
 *     - LLM request/response details
 *     - the time spent in each step of the whole L2 extraction chain
 *
 * Design principles:
 *   1. After extraction completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the extraction result is unaffected
 *   3. No reporting when extraction fails (hasError=true)
 *   4. No reporting when there is no instanceId
 *   5. llmDurationMs null means no LLM call timing; l2_llm_duration_ms is not reported
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L2LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Total end-to-end L2 scene extraction time (ms) */
  extractionLatencyMs: number;
  /** LLM call duration (ms). null means no LLM call timing */
  llmDurationMs: number | null;
  /** Number of scenes before extraction */
  sceneCountBefore: number;
  /** Number of scenes after extraction */
  sceneCountAfter: number;
  /** Number of scenes created this time */
  scenesCreated: number;
  /** Number of scenes updated this time */
  scenesUpdated: number;
  /** Number of scenes deleted this time */
  scenesDeleted: number;
  /** Whether extraction failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report the L2 scene extraction metrics to Kafka.
 *
 * Silent and safe: any exception is swallowed by try-catch and never thrown outward.
 */
export function reportL2LatencyMetrics(input: L2LatencyMetricInput): void {
  try {
    // Guard: no reporting on failure
    if (input.hasError) return;

    // Guard: no reporting without instanceId
    if (!input.instanceId) return;

    // 1. Report l2_extraction_latency_ms
    try {
      metricProducer.send({
        metric: "l2_extraction_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.extractionLatencyMs),
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 2. Report l2_llm_duration_ms (only when there is LLM timing)
    if (input.llmDurationMs !== null) {
      try {
        metricProducer.send({
          metric: "l2_llm_duration_ms",
          instanceId: input.instanceId,
          value: Math.round(input.llmDurationMs),
          source: "core",
        });
      } catch {
        // Silent failure
      }
    }

    // 3. Report l2_scene_count_before
    try {
      metricProducer.send({
        metric: "l2_scene_count_before",
        instanceId: input.instanceId,
        value: input.sceneCountBefore,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 4. Report l2_scene_count_after
    try {
      metricProducer.send({
        metric: "l2_scene_count_after",
        instanceId: input.instanceId,
        value: input.sceneCountAfter,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 5. Report l2_scenes_created
    try {
      metricProducer.send({
        metric: "l2_scenes_created",
        instanceId: input.instanceId,
        value: input.scenesCreated,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 6. Report l2_scenes_updated
    try {
      metricProducer.send({
        metric: "l2_scenes_updated",
        instanceId: input.instanceId,
        value: input.scenesUpdated,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 7. Report l2_scenes_deleted
    try {
      metricProducer.send({
        metric: "l2_scenes_deleted",
        instanceId: input.instanceId,
        value: input.scenesDeleted,
        source: "core",
      });
    } catch {
      // Silent failure
    }
  } catch {
    // Outermost catch — never throw outward
  }
}
