/**
 * L3 Persona Generation Metric Reporter — L3 persona generation metric reporting.
 *
 * After L3 persona generation completes, non-intrusively reports the following metrics to Kafka:
 *   - l3_generation_latency_ms : total end-to-end L3 persona generation time (ms)
 *   - persona_length_before    : persona character count before the update (0 on initial generation)
 *   - persona_length_after     : persona character count after the update
 *
 * Trace correlation:
 *   All metrics automatically get the traceId of the current active span via metricProducer.send().
 *   L3 runs inside TracedTaskExecutor.executeL3() → withSpan("core.l3.generation"),
 *   whose child spans include the ai.generateText / gen_ai.chat spans produced automatically by the Vercel AI SDK,
 *   carrying the gen_ai.request.model attribute. Through the traceId you can look up:
 *     - which model was used (gen_ai.request.model)
 *     - LLM prompt and response details
 *     - the full call chain of persona generation
 *     - the duration of that LLM call
 *
 * Design principles:
 *   1. After generation completes, report inside try-catch (silent failure)
 *   2. Whether reporting succeeds or fails, the generation result is unaffected
 *   3. No reporting when generation fails (hasError=true)
 *   4. No reporting when there is no instanceId
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L3LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Total end-to-end L3 persona generation time (ms) */
  generationLatencyMs: number;
  /** Persona character count before the update (pass 0 on initial generation) */
  personaLengthBefore: number;
  /** Persona character count after the update */
  personaLengthAfter: number;
  /** Persona plain text before the update (used to compute the drift ratio, optional) */
  personaTextBefore?: string;
  /** Persona plain text after the update (used to compute the drift ratio, optional) */
  personaTextAfter?: string;
  /** Whether generation failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report the L3 persona generation metrics to Kafka.
 *
 * Silent and safe: any exception is swallowed by try-catch and never thrown outward.
 */
export function reportL3LatencyMetrics(input: L3LatencyMetricInput): void {
  try {
    // Guard: no reporting on failure
    if (input.hasError) return;

    // Guard: no reporting without instanceId
    if (!input.instanceId) return;

    // 1. Report l3_generation_latency_ms
    try {
      metricProducer.send({
        metric: "l3_generation_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.generationLatencyMs),
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 2. Report persona_length_before
    try {
      metricProducer.send({
        metric: "persona_length_before",
        instanceId: input.instanceId,
        value: input.personaLengthBefore,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 3. Report persona_length_after
    try {
      metricProducer.send({
        metric: "persona_length_after",
        instanceId: input.instanceId,
        value: input.personaLengthAfter,
        source: "core",
      });
    } catch {
      // Silent failure
    }

    // 4. Report persona_drift_ratio (line-level diff)
    //    Computation: split old and new personas into lines, count (added lines + removed lines) / total lines
    //    Range [0, 1]: 0 = unchanged, 1 = completely rewritten
    //    Only computed when before/after text is present and it is not the first generation
    try {
      if (input.personaTextBefore != null && input.personaTextAfter != null && input.personaTextBefore.length > 0) {
        const driftRatio = computeLineDriftRatio(input.personaTextBefore, input.personaTextAfter);
        metricProducer.send({
          metric: "persona_drift_ratio",
          instanceId: input.instanceId,
          value: driftRatio,
          source: "core",
        });
      }
    } catch {
      // Silent failure
    }
  } catch {
    // Outermost catch — never throw outward
  }
}

// ============================
// Helpers
// ============================

/**
 * Compute the line-level drift ratio (option C).
 *
 * Split old and new personas into lines (ignoring blank lines), then compute:
 *   drift = (added lines + removed lines) / max(old lines + new lines, 1)
 *
 * Range [0, 1]:
 *   0   = identical content
 *   ~0.1 = minor tweak (a few lines changed)
 *   ~0.5 = major edit
 *   1   = completely rewritten (no line in common)
 *
 * Performance: O(n) time + O(n) space; a persona is usually 50-200 lines, taking < 0.1ms.
 */
export function computeLineDriftRatio(before: string, after: string): number {
  const oldLines = before.split("\n").filter((l) => l.trim().length > 0);
  const newLines = after.split("\n").filter((l) => l.trim().length > 0);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const added = newLines.filter((l) => !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => !newSet.has(l)).length;

  const total = oldLines.length + newLines.length;
  if (total === 0) return 0;

  // Normalize to [0, 1]
  return Math.min((added + removed) / total, 1);
}
