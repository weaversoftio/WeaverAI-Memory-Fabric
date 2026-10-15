/**
 * wiki-constants -- constants, types and pure utility functions of the Wiki asset page.
 * Split out from WikiSourcesPanel.tsx, reused by the main panel / detail view / hooks.
 *
 * The generic asset types and formatShortTime have been consolidated into @/lib/asset-common; they are re-exported here
 * to keep the original import paths unchanged.
 */
import type { WikiDetail } from '@/lib/api/knowledge-api';
export type { SubView, ViewMode, StatusFilter } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/** Wiki allows uploading only Markdown-type files (.md / .markdown / .txt). */
export const WIKI_ALLOWED_FILE_RE = /\.(md|txt|markdown)$/i;

// Wiki status badges: draft = shell created but not processed (waiting for the user to click ingest); pending = queued; processing = in progress; ready = ready; failed = failed; missing = KS data lost.
// Uses the semantic theme of UI kit Tag (soft variant), responding to the theme, with no hard-coded palette colors.
export const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
export const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--wf-color-bg-brand-default)',
  concept: 'var(--wf-color-bg-warning-default)',
  source: 'var(--wf-color-bg-amber-default)',
  query: 'var(--wf-color-bg-success-default)',
  synthesis: 'var(--wf-color-bg-error-default)',
  overview: 'var(--wf-color-bg-yellow-default)',
  comparison: 'var(--wf-color-bg-secondary-active)',
  finding: 'var(--wf-color-bg-warning-default)',
  thesis: 'var(--wf-color-bg-error-default)',
  methodology: 'var(--wf-color-bg-success-default)',
  other: 'var(--wf-color-bg-tertiary-default)',
  raw: 'var(--wf-color-bg-secondary-default)',
};
export const TYPE_COLOR_FALLBACK = 'var(--wf-color-text-tertiary)';
