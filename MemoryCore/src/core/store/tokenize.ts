/**
 * Store-layer shared tokenization + BM25 score helpers.
 *
 * These were historically defined in `sqlite.ts` and imported across the
 * codebase (`memory-search`, `conversation-search`, `skill-store`, `l1-dedup`,
 * `auto-recall`). They are backend-agnostic — the SQLite FTS5 path, the remote-store
 * sparse-vector path, and the MongoDB `$search` path all need the same
 * tokenization so that write-side and query-side tokens line up.
 *
 * Canonical location is here; `sqlite.ts` re-exports for backward compatibility.
 *
 * Design (D6): query and index text are split on Unicode letters, digits, and
 * underscores; tokens are space-joined for whitespace analyzers on write-side.
 */

/**
 * Build an FTS5 MATCH query from raw text.
 *
 * Tokens are OR-joined as quoted FTS5 phrase terms so that a document matching
 * *any* token is returned. BM25 naturally ranks documents that match more
 * tokens higher, so precision is preserved while recall improves.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];

  const unique = [...new Set(tokens)];
  if (unique.length === 0) return null;
  const quoted = unique.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Return the raw keyword tokens (de-duplicated) for a query.
 *
 * Unlike {@link buildFtsQuery} (which produces FTS5 MATCH syntax), this yields
 * a plain token array — used by backends whose query language is not FTS5, e.g.
 * MongoDB `$search` where we join tokens with spaces for a whitespace analyzer.
 * Returns `[]` when nothing meaningful remains.
 */
export function extractQueryTokens(raw: string): string[] {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  return [...new Set(tokens)];
}

/**
 * Tokenize text for keyword indexing (write-side).
 *
 * Joins Unicode word tokens with spaces for whitespace / unicode61 FTS analyzers.
 */
export function tokenizeForFts(raw: string): string {
  const tokens = extractQueryTokens(raw);
  if (tokens.length === 0) return raw;
  return tokens.join(" ");
}

/**
 * Convert a SQLite FTS5 BM25 rank (negative = more relevant) to a 0–1 score.
 * Mirrors the formula in openclaw core `hybrid.ts`.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/**
 * Convert a MongoDB `$search` `$meta:"searchScore"` (unbounded positive, higher
 * = more relevant) to the same 0–1 scale as SQLite BM25 (D12).
 *
 * SQLite's `bm25RankToScore` maps a *relevance* magnitude via
 * `relevance / (1 + relevance)` (its negative branch). Mongo's searchScore is
 * already a positive relevance, so we feed it through the identical transform.
 * This keeps the downstream `scoreThreshold=0.3` gate meaningful across both
 * backends without touching SQLite or the threshold. Equivalent to
 * `bm25RankToScore(-searchScore)` for searchScore > 0.
 */
export function mongoSearchScoreToScore(searchScore: number): number {
  if (!Number.isFinite(searchScore) || searchScore <= 0) return 0;
  return searchScore / (1 + searchScore);
}
