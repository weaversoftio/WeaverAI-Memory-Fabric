/**
 * Credit pricing lookup for LLM usage → cost calculation.
 *
 * Billing rules delivered by WAMF use Credit / 1K Token as the unit, priced separately by token type
 * (input / output / cacheRead / cacheWrite5m / cacheWrite1h).
 * The pricing table lives in `creditPricing.models` of config.yaml and supports hot reload.
 *
 * Matching rule (`getModelPricing`):
 *   case-insensitive whole-word match -- modelId and config.name must be exactly equal after ignoring case.
 *   Returns null when unmatched, and the caller degrades to the raw token count.
 */

import type { CreditPricingConfig, CreditPricingEntry, PricingTier } from "./types.js";

/**
 * Look up model pricing by case-insensitive full-word match.
 *
 * @param config - Credit pricing configuration (from config.yaml).
 * @param modelId - Model identifier (usually the `model` field from usage).
 * @returns Matched pricing entry, or `null` if no match.
 */
export function getModelPricing(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): CreditPricingEntry | null {
  if (!config?.models?.length || !modelId) return null;

  const lower = modelId.toLowerCase();
  return config.models.find((m) => m.name.toLowerCase() === lower) ?? null;
}

/**
 * Resolve a model's display name (for UI / reports).
 *
 * Matching logic:
 * 1. `modelId` empty/null/undefined -> return `""`
 * 2. pricing table hit and entry.modelName non-empty -> return entry.modelName (e.g. "Claude Sonnet 4")
 * 3. pricing table miss, or hit but modelName not configured / empty -> **fall back to modelId itself**
 *    (the frontend always has a non-empty display; an unknown model at least shows its internal ID)
 *
 * Shares one matching logic with `getModelPricing` (case-insensitive whole-word match).
 *
 * @param config - Credit pricing configuration.
 * @param modelId - Model identifier from usage.
 * @returns display name string (never null, may be "").
 */
export function resolveModelName(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): string {
  if (!modelId) return "";
  const entry = getModelPricing(config, modelId);
  return entry?.modelName || modelId;
}

/**
 * Reverse resolution: translate the client-side display name (`modelName`) back to the real `model_id` (`entry.name`).
 *
 * Used at the request interception stage -- the client may fill the `model` field with an easily recognizable `modelName`
 * (e.g. `claude-opus-4.7`), and the proxy swaps it for the corresponding model_id
 * (e.g. `ep-pksklwtb`) before forwarding upstream. It is the inverse of `resolveModelName`, reusing the same
 * `creditPricing.models` mapping to avoid maintaining two copies.
 *
 * Matching logic (case-insensitive, consistent with `getModelPricing`):
 * 1. `requested` empty/null/undefined -> return as is (empty string)
 * 2. hits some entry's `modelName` (ignoring case, non-empty) -> return that entry's `name`
 * 3. no hit (including when requested is already a real model_id, or an unknown model) -> **return as is**
 *    (guarantees backward compatibility: clients passing the real model_id directly are unaffected)
 *
 * If the same `modelName` maps to multiple entries, the first hit wins (`Array.find` semantics).
 *
 * @param config - Credit pricing configuration.
 * @param requested - value of the `model` field in the client request.
 * @returns the real model_id; falls back to `requested` itself when there is no match.
 */
export function resolveModelId(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): string {
  if (!requested) return requested ?? "";
  if (!config?.models?.length) return requested;

  const lower = requested.toLowerCase();
  const entry = config.models.find(
    (m) => !!m.modelName && m.modelName.toLowerCase() === lower,
  );
  return entry?.name || requested;
}

/**
 * Validate whether the client-requested `model` is registered among the **`modelName` (display names)** of the price list.
 *
 * Used as a gate at the request entry: when a price list is configured, clients may only request by display name (`modelName`);
 * the real `model_id` (`entry.name`) is treated as an internal detail and no longer a public entry point.
 * Unmatched models are always rejected, avoiding the silent under-billing problem of "forwarded successfully but cannot be billed".
 *
 * Rules:
 * 1. `config` / `config.models` empty -> **return true** (skip validation when no price list is configured,
 *    backward compatible with old deployments; handled by `computeCreditDelta` through the raw trace-back path).
 * 2. `requested` empty/null/undefined -> **return false** (model must be provided explicitly to be let through).
 * 3. hits any entry's **non-empty** `modelName` (case-insensitive whole-word match) -> true.
 * 4. otherwise -> false.
 *
 * Note: an entry without a configured `modelName` cannot be hit by client requests (that model is then "internal only",
 * used only for internal forwarding and not exposed to clients).
 *
 * @param config - Credit pricing configuration.
 * @param requested - value of the `model` field in the client request.
 * @returns whether to let it through.
 */
export function isModelInPricing(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): boolean {
  // Price list not configured: skip validation (backward compatible)
  if (!config?.models?.length) return true;
  // Explicitly require a non-empty model
  if (!requested) return false;

  const lower = requested.toLowerCase();
  return config.models.some(
    (m) => !!m.modelName && m.modelName.toLowerCase() === lower,
  );
}

/** Pricing rates used for credit calculation (subset of PricingTier). */
export interface EffectivePricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * Select the effective pricing tier by total input tokens.
 *
 * Matching rule: iterate `entry.tiers` in ascending order; the first one satisfying
 * `totalInputTokens <= tier.maxInputTokens` (or `maxInputTokens == null`) hits.
 * After a hit, **all token types** of that request are billed at that tier's unit price (whole-request tiering, not piecewise progressive).
 *
 * When there are no `tiers` or the array is empty, return the entry's top-level unit price directly (backward compatible).
 *
 * @param entry - the matched model pricing entry.
 * @param totalInputTokens - tiering criterion = nonCacheInput + cacheRead.
 */
export function resolveTierPricing(
  entry: CreditPricingEntry,
  totalInputTokens: number,
): EffectivePricing {
  if (!entry.tiers?.length) return entry;

  for (const tier of entry.tiers) {
    if (tier.maxInputTokens == null || totalInputTokens <= tier.maxInputTokens) {
      return tier;
    }
  }
  // No tier hit (theoretically impossible, the last tier should be null) -> fall back to the top-level
  return entry;
}
