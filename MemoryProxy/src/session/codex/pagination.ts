/**
 * Codex `request_user_input` pagination layouter -- structure copied from
 * `session/claude-code/pagination.ts`, only codex's option cap differs from CC:
 *
 * - a codex single question has at most **3** options (the client automatically appends "Other" taking 1 slot,
 *   we must not stuff it ourselves, so 2 or 3 slots are actually usable)
 * - middle pages need to reserve 1 slot for the "MORE ->" page flip -> at most 2 real per page
 * - the last page has no MORE -> can fill all 3
 *
 * Strategy:
 *   - total <= 3: show everything on a single page (no MORE)
 *   - total > 3: the first N-1 pages have 2 real + MORE each, the last page takes the rest (in [2, 3])
 *
 * Page count: `totalPages = ceil((total - 3) / 2) + 1`
 *   - the first N-1 pages have 2 real each = 2(N-1) items
 *   - the last page has total - 2(N-1) items
 *
 * Effect:
 *   total=3  -> [3]                   (single page)
 *   total=4  → [2+MORE, 2]
 *   total=5  -> [2+MORE, 3]           <- the last page is filled to 3, avoiding a solo item compared with "2+2+1"
 *   total=6  → [2+MORE, 2+MORE, 2]
 *   total=7  → [2+MORE, 2+MORE, 3]
 *   total=8  → [2+MORE, 2+MORE, 2+MORE, 2]
 *
 * Each page's count is always >= 2 and <= 3; the last page is never solo.
 *
 * Shares the same philosophy as CC pagination, only the constants differ (3/2 vs 4/3). Both agents and tasks
 * use this scheme.
 */

/** codex `request_user_input` hard cap on options per question (the client's "Other" slot is separate). */
export const CODEX_MAX_OPTIONS = 3;

/** Number of real options on a non-last page (reserving 1 slot for MORE->). */
export const CODEX_PAGE_SIZE = 2;

/** Single-page threshold: when total <= this value, no pagination and no MORE. */
export const CODEX_SINGLE_PAGE_LIMIT = CODEX_MAX_OPTIONS;

export interface CodexPageSlice {
  /** The element range [start, end) covered by this page. */
  start: number;
  end: number;
  /** Whether this page is the last one (the last page does not append a MORE option). */
  isLastPage: boolean;
  /** Number of real options shown on this page (= end - start). */
  count: number;
  /** Total number of pages after pagination (1 when total <= 3). */
  totalPages: number;
  /** Total number of elements, handy for callers building hint text. */
  total: number;
}

/**
 * Compute the slice range for a given `total` items and target `pageIndex` (0-based).
 *
 * Guarantees: any valid pageIndex returns `count >= 2` (unless total < 2 -- that boundary is
 * handled by the upstream form builder).
 *
 * When pageIndex exceeds totalPages-1 it is clamped to the last page (defensive; normal callers first
 * use totalPages-1 to compute safeNextPage).
 */
export function computeCodexPagination(
  total: number,
  pageIndex: number,
): CodexPageSlice {
  const safeTotal = Math.max(0, total);

  if (safeTotal <= CODEX_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 3: the first N-1 pages have 2 real + MORE each, the last page takes total - 2(N-1) items (in [2, 3]).
  const totalPages =
    Math.ceil((safeTotal - CODEX_MAX_OPTIONS) / CODEX_PAGE_SIZE) + 1;

  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));
  const isLastPage = idx === totalPages - 1;
  const start = idx * CODEX_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CODEX_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
