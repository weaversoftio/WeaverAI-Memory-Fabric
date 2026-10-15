/**
 * Claude Code AskUserQuestion pagination layouter.
 *
 * Background: CC AskUserQuestion allows at most 4 options per question. Middle pages must reserve 1
 * slot for "More ->", so at most 3 real items fit; the last page has no MORE and can hold all 4.
 *
 * Strategy:
 *   - total <= 4: show everything on a single page (no MORE)
 *   - total > 4: the first N-1 pages have 3 items + MORE each, the last page takes the rest (in [2, 4])
 *
 * Page count: `totalPages = ceil((total - 4) / 3) + 1`
 *   - the first N-1 pages have 3 items each = 3(N-1) items
 *   - the last page has total - 3(N-1) items
 *   - solving back for N: total - 3(N-1) in [2, 4] <=> N - 1 = ceil((total - 4) / 3)
 *
 * Effect:
 *   total=4  -> [4]                   (single page)
 *   total=5  → [3+MORE, 2]
 *   total=6  → [3+MORE, 3]
 *   total=7  -> [3+MORE, 4]           <- the last page is filled to 4, one page fewer than "3+2+2"
 *   total=8  → [3+MORE, 3+MORE, 2]
 *   total=9  → [3+MORE, 3+MORE, 3]
 *   total=10 -> [3+MORE, 3+MORE, 4]   <- the last page is filled to 4
 *   total=11 → [3+MORE, 3+MORE, 3+MORE, 2]
 *   total=13 → [3+MORE ×3, 4]
 *
 * Each page's count is always >= 2 and <= 4, never a solo last page -- the autoSelectSolo* fallback
 * branch in init.ts can therefore never reach the MORE paging path (the total===1 case is auto-selected
 * upstream by advanceFromAgentPicked and never reaches the form either).
 *
 * agents and tasks share the same pagination, so behaviour is consistent.
 */

/** CC AskUserQuestion hard cap per question (including the MORE slot). */
export const CC_MAX_OPTIONS = 4;

/** Number of real options on a non-last page (reserving 1 slot for MORE->). */
export const CC_PAGE_SIZE = 3;

/** Single-page display threshold: when total <= this value, no pagination and no MORE; one page shows everything. */
export const CC_SINGLE_PAGE_LIMIT = CC_MAX_OPTIONS;

export interface PageSlice {
  /** The element range [start, end) covered by this page, start inclusive and end exclusive -- use directly with slice. */
  start: number;
  end: number;
  /** Whether this page is the last one (the last page does not append a MORE option). */
  isLastPage: boolean;
  /** Number of real options shown on this page (= end - start). */
  count: number;
  /** Total number of pages after pagination (1 when total <= 4). */
  totalPages: number;
  /** Total number of elements, handy for callers building hint text. */
  total: number;
}

/**
 * Compute the slice range for a given `total` items and target `pageIndex` (0-based).
 *
 * Guarantees: any valid pageIndex returns `count >= 2` (unless total < 2, which is a
 * boundary issue upstream in the form builder and not this function's responsibility).
 *
 * When pageIndex exceeds totalPages-1 it is clamped to the last page (defensive; normal callers first
 * use totalPages-1 to compute safeNextPage, see the MORE branch in init.ts).
 */
export function computePagination(total: number, pageIndex: number): PageSlice {
  const safeTotal = Math.max(0, total);

  // Single-page threshold: no pagination when <= CC_SINGLE_PAGE_LIMIT.
  if (safeTotal <= CC_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 4: the first N-1 pages have 3 real + MORE each, the last page takes total - 3(N-1) items (in [2, 4]).
  // N - 1 pages carrying 3 each need >= (total - 4) items (the last page holds at most 4), i.e. N-1 = ceil((total-4) / 3).
  const totalPages = Math.ceil((safeTotal - CC_MAX_OPTIONS) / CC_PAGE_SIZE) + 1;

  // Clamp pageIndex to the valid range (defensive).
  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));

  const isLastPage = idx === totalPages - 1;
  const start = idx * CC_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CC_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
