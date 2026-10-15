/**
 * Per-member aggregation - merges call details by user_id on the panel side.
 *
 * Why on the panel side: the kernel offers no "aggregate by member" display API
 * (`tool-calls/watermark` does GROUP BY user_id, but its return is a fingerprint structure
 * for the recall incremental pipeline, without endpoint/latency, so it is unsuitable for display); Core is not changed in this phase.
 *
 * Warning, **sampling basis**: data comes from paginated pulls of `tool-calls/list`, max 200 per page and at most
 * MAX_SAMPLE_PAGES pages. When total exceeds the sampled amount, truncated=true and the UI must explicitly label
 * "based on the latest N / total records"; it must not be treated as the full set.
 */
import { classifyAsset, type AssetCategory } from './asset-category';
import type { ToolCallRow } from '@/lib/api/analytics';

/** Maximum number of sampled pages (200/page -> up to 2000 records). */
export const MAX_SAMPLE_PAGES = 10;

export interface MemberStat {
  user_id: string;
  /** Number of calls within the sampling window. */
  calls: number;
  /** Number of distinct sessions. */
  sessions: number;
  /** Asset category this member called the most. */
  topCategory: AssetCategory | null;
  /** Call counts per category. */
  byCategory: Record<AssetCategory, number>;
  /** Average latency (ms). */
  avgElapsedMs: number;
  /** Number of failures (upstream_status >= 400 or non-empty reject_reason). */
  errors: number;
  /** Time of the most recent call within the sampling window. */
  lastCallAt: string;
}

function emptyByCategory(): Record<AssetCategory, number> {
  return { memory: 0, skill: 0, wiki: 0, codegraph: 0, other: 0 };
}

/**
 * Label of the aggregation bucket for an empty user_id.
 *
 * Warning: this is **not** a real user_id, only a panel-side placeholder group:
 *   - Must not be used for user/list name resolution (it would waste a user_ids quota slot and find nothing)
 *   - Must not be used for drill-down (passing it to the kernel as a user_id is semantically wrong)
 * Callers must explicitly recognize and skip it; for display use the i18n "unassigned".
 */
export const UNASSIGNED_USER = '(unassigned)';

/**
 * Aggregate call details by user_id, returned in descending order of call count.
 *
 * Rows with an empty user_id go into the `UNASSIGNED_USER` bucket: such events do exist in CH
 * (the reporting side carried no user context), and silently dropping them would make totals disagree with the KPIs.
 */
export function aggregateByMember(rows: ToolCallRow[]): MemberStat[] {
  const map = new Map<
    string,
    MemberStat & { sessionSet: Set<string>; elapsedSum: number; elapsedCount: number }
  >();

  for (const row of rows) {
    const key = row.user_id || UNASSIGNED_USER;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        user_id: key,
        calls: 0,
        sessions: 0,
        topCategory: null,
        byCategory: emptyByCategory(),
        avgElapsedMs: 0,
        errors: 0,
        lastCallAt: '',
        sessionSet: new Set<string>(),
        elapsedSum: 0,
        elapsedCount: 0,
      };
      map.set(key, entry);
    }

    entry.calls += 1;
    if (row.session_key) entry.sessionSet.add(row.session_key);

    const category = classifyAsset(row.executed_endpoint, row.bridge_source);
    entry.byCategory[category] += 1;

    // elapsed_ms of 0 mostly means not recorded; excluded from the average's denominator, so the average latency is not diluted to 0
    if (row.elapsed_ms > 0) {
      entry.elapsedSum += row.elapsed_ms;
      entry.elapsedCount += 1;
    }

    if (row.upstream_status >= 400 || row.reject_reason) entry.errors += 1;
    if (row.timestamp > entry.lastCallAt) entry.lastCallAt = row.timestamp;
  }

  return Array.from(map.values())
    .map((e) => {
      const entries = Object.entries(e.byCategory) as Array<[AssetCategory, number]>;
      const top = entries.reduce<[AssetCategory, number] | null>(
        (acc, cur) => (cur[1] > 0 && (!acc || cur[1] > acc[1]) ? cur : acc),
        null,
      );
      return {
        user_id: e.user_id,
        calls: e.calls,
        sessions: e.sessionSet.size,
        topCategory: top ? top[0] : null,
        byCategory: e.byCategory,
        avgElapsedMs: e.elapsedCount > 0 ? Math.round(e.elapsedSum / e.elapsedCount) : 0,
        errors: e.errors,
        lastCallAt: e.lastCallAt,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.user_id.localeCompare(b.user_id));
}
