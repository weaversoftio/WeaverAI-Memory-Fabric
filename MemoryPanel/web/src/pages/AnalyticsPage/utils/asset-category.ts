/**
 * Endpoint / bridge_source -> four asset categories (Memory / Skill / Wiki / Code Graph) classification.
 *
 * Why on the panel side: CH's `tool_call_logs` only records `executed_endpoint` and
 * `bridge_source`, and the kernel's `tool-calls/endpoint-share` aggregates by raw endpoint (17 flat entries),
 * lacking business semantics. Core is not changed in this phase, so the classification rules live on the panel side - like the legacy panel
 * (online-data-platform `trace-context.ts:normalizeCategory`) it is plain string
 * matching, with no LLM involved.
 *
 * Decision priority:
 *   1. bridge_source (most authoritative): memory-bridge / skill-bridge / knowledge-service
 *   2. Endpoint prefix / endpoint name (the only basis when endpoint-share has just endpoint names)
 *   3. Fallback other - new endpoints are not misclassified when they go live, but explicitly exposed as "Other"
 *
 * If a new endpoint falls into other, add a rule here rather than letting it silently blend into some category.
 */

export type AssetCategory = 'memory' | 'skill' | 'wiki' | 'codegraph' | 'other';

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'memory',
  'skill',
  'wiki',
  'codegraph',
  'other',
] as const;

/** Within knowledge-service, endpoints are further split into Wiki / Code Graph. */
const CODEGRAPH_TOOLS = ['node', 'impact', 'files', 'refs', 'callers', 'callees', 'graph'];
const WIKI_TOOLS = ['search', 'explore', 'read_page', 'list_pages', 'get_info', 'page'];

/** memory-side endpoints (including the three groups scenario / atomic / conversation). */
const MEMORY_PREFIXES = ['atomic/', 'scenario/', 'conversation/', 'persona', 'chat-memory'];

/** skill-side endpoints. */
const SKILL_EXACT = ['get', 'get-by-name', 'search', 'list', 'listing', 'extract', 'versions', 'fork'];
const SKILL_PREFIXES = ['files/', 'skill/'];

function classifyKnowledgeTool(endpoint: string): AssetCategory {
  // Of the form tools/call/<tool>; the last segment decides
  const tool = endpoint.split('/').pop() ?? '';
  if (CODEGRAPH_TOOLS.some((t) => tool.includes(t))) return 'codegraph';
  if (WIKI_TOOLS.some((t) => tool.includes(t))) return 'wiki';
  return 'wiki';
}

/**
 * Classify a single call.
 *
 * @param endpoint executed_endpoint (required, the only basis in the endpoint-share scenario)
 * @param bridgeSource bridge_source (optional, available in the tool-calls/list scenario, highest priority)
 */
export function classifyAsset(endpoint: string, bridgeSource?: string): AssetCategory {
  const src = (bridgeSource ?? '').toLowerCase();
  const ep = (endpoint ?? '').toLowerCase();

  // 1. bridge_source first
  if (src.startsWith('memory')) return 'memory';
  if (src.startsWith('skill')) return 'skill';
  if (src.startsWith('knowledge')) return classifyKnowledgeTool(ep);

  if (!ep) return 'other';

  // 2. Endpoint decision
  if (ep.startsWith('tools/call/')) return classifyKnowledgeTool(ep);
  if (MEMORY_PREFIXES.some((p) => ep.startsWith(p))) return 'memory';
  if (SKILL_PREFIXES.some((p) => ep.startsWith(p))) return 'skill';
  if (SKILL_EXACT.includes(ep)) return 'skill';

  // 3. Fallback: do not guess
  return 'other';
}

export interface CategoryStat {
  category: AssetCategory;
  calls: number;
  pct: number;
  /** Raw endpoints in this category (descending by call count), used by the tooltip to show the classification basis. */
  endpoints: Array<{ endpoint: string; calls: number }>;
}

/**
 * Merge the full aggregation result of endpoint-share into the four categories.
 *
 * The input comes from the kernel's full SQL aggregation, so the output calls/pct are also **exact full-set values**,
 * not sampled (unlike the member dimension). pct is recomputed from the total calls of the rows passed in, avoiding
 * rounding deviations from directly adding raw pct values.
 */
export function aggregateByCategory(
  rows: Array<{ executed_endpoint: string; calls: number }>,
): CategoryStat[] {
  const buckets = new Map<AssetCategory, { calls: number; endpoints: Array<{ endpoint: string; calls: number }> }>();
  let total = 0;

  for (const row of rows) {
    const category = classifyAsset(row.executed_endpoint);
    const calls = Number(row.calls) || 0;
    total += calls;
    const bucket = buckets.get(category) ?? { calls: 0, endpoints: [] };
    bucket.calls += calls;
    bucket.endpoints.push({ endpoint: row.executed_endpoint, calls });
    buckets.set(category, bucket);
  }

  return ASSET_CATEGORIES.map((category) => {
    const bucket = buckets.get(category);
    return {
      category,
      calls: bucket?.calls ?? 0,
      pct: total > 0 ? Math.round(((bucket?.calls ?? 0) / total) * 10000) / 100 : 0,
      endpoints: (bucket?.endpoints ?? []).sort((a, b) => b.calls - a.calls),
    };
  })
    // An other with all zeros is not shown, to avoid noise; the four main asset categories are always shown (0 is meaningful too)
    .filter((s) => s.category !== 'other' || s.calls > 0);
}
