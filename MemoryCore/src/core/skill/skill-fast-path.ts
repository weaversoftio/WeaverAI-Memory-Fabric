/**
 * skill-fast-path — name-substring quick-match channel.
 *
 * Design: docs/design/2026-06-30-skill-router.md §4.2
 *
 * An independent fast path that runs in parallel with the main channel (BM25 / embedding / hybrid via ISkillStore.searchSkills).
 * When the skill name length ≥ NAME_MATCH_MIN_LENGTH (default 4) and the user query (lowercased) contains that
 * skill name (substring match), the skill is hit by the fast path.
 *
 * Merge rules (implemented in handleListing):
 * - skills hit by the fast path are placed first in the final result
 * - main-channel results are de-duplicated and appended after them
 * - they do not go through the reranker, to avoid disturbing the already-reranked main channel order
 *
 * Performance: pure in-memory string operations, no I/O, no model inference; iterating 80k skills takes <5ms.
 *
 * DECISION (2026-06-30): not wired in for now. Evaluation conclusion:
 *   - the fast-path needs to pull the full set first (name + description); in remote-store mode a network pull of
 *     1000+ skills takes 80-150ms (same region) or more, far beyond the <5ms of pure in-memory matching.
 *   - the main channel BM25/hybrid naturally weights the name field highly (FTS5 name column position 0),
 *     so when a user mentions a name the main channel most likely already hits it in the top-K.
 *   - the benefit is limited (it only serves the edge case where "the user explicitly mentions a skill name") but the cost is
 *     2-6x the queries (search + full list + in-memory matching vs a single search).
 *   The file is kept, to be re-evaluated when data later shows recall is insufficient.
 */
import type { Skill } from "./types.js";

export const DEFAULT_NAME_MATCH_MIN_LENGTH = 4;

/**
 * Returns the skills in `skills` whose `name` length ≥ `minLength` and where the query (lowercased) contains that name (lowercased).
 * An empty query or all-whitespace short-circuits and returns `[]`.
 */
export function nameMatchFastPath(
  query: string,
  skills: Skill[],
  minLength: number = DEFAULT_NAME_MATCH_MIN_LENGTH,
): Skill[] {
  const q = (query ?? "").toLowerCase().trim();
  if (q === "") return [];
  return skills.filter(
    (s) => s.name.length >= minLength && q.includes(s.name.toLowerCase()),
  );
}
