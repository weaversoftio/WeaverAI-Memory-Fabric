/**
 * Data components: Tabs/TabPanel, Pagination, Table (+ addons autotip / scrollable / expandable).
 */
import { Children, Fragment, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './internal';
import { StatusTip } from './Display';

// ───────────────────────── Tabs ─────────────────────────

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId?: string;
  onActive?: (tab: TabItem) => void;
  /** Extra content at the end of the tab bar. */
  addon?: ReactNode;
  disableTabScrolling?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export interface TabPanelProps {
  id: string;
  className?: string;
  children?: ReactNode;
}

export function TabPanel({ className, children }: TabPanelProps) {
  return (
    <div role="tabpanel" className={cn('wf-tabs__panel', className)}>
      {children}
    </div>
  );
}

export function Tabs({ tabs, activeId, onActive, addon, className, style, children }: TabsProps) {
  const current = activeId ?? tabs[0]?.id;
  // Only the active panel is mounted.
  const panel = Children.toArray(children).find(
    (c) => isValidElement(c) && (c as ReactElement<TabPanelProps>).props.id === current,
  );
  return (
    <div className={cn('wf-tabs', className)} style={style}>
      <div className="wf-tabs__tabbar">
        <div role="tablist" className="wf-tabs__tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === current}
              disabled={tab.disabled}
              className={cn('wf-tabs__tab', tab.id === current && 'is-active')}
              onClick={() => tab.id !== current && onActive?.(tab)}
            >
              <span className="wf-tabs__tabitem">{tab.label}</span>
            </button>
          ))}
        </div>
        {addon && <div className="wf-tabs__addon">{addon}</div>}
      </div>
      {panel}
    </div>
  );
}

// ───────────────────────── Pagination ─────────────────────────

export interface PagingQuery {
  pageIndex: number;
  pageSize: number;
}

export interface PaginationProps {
  /** 1-based page index. */
  pageIndex?: number;
  pageSize?: number;
  recordCount: number;
  pageSizeVisible?: boolean;
  pageSizeOptions?: number[];
  onPagingChange?: (query: PagingQuery) => void;
  className?: string;
}

function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('…');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push('…');
  pages.push(total);
  return pages;
}

export function Pagination({
  pageIndex = 1,
  pageSize = 20,
  recordCount,
  pageSizeVisible = true,
  pageSizeOptions = [10, 20, 50, 100],
  onPagingChange,
  className,
}: PaginationProps) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(recordCount / pageSize));
  const go = (p: number) => {
    const next = Math.min(totalPages, Math.max(1, p));
    if (next !== pageIndex) onPagingChange?.({ pageIndex: next, pageSize });
  };
  return (
    <nav className={cn('wf-pagination', className)} aria-label={t('ui.pagination.label')}>
      <span className="wf-pagination__total">{t('ui.pagination.total', { count: recordCount })}</span>
      {pageSizeVisible && (
        <select
          className="wf-pagination__size"
          value={pageSize}
          onChange={(e) => onPagingChange?.({ pageIndex: 1, pageSize: Number(e.target.value) })}
        >
          {pageSizeOptions.map((s) => (
            <option key={s} value={s}>
              {t('ui.pagination.perPage', { count: s })}
            </option>
          ))}
        </select>
      )}
      <div className="wf-pagination__pages">
        <button
          type="button"
          className="wf-pagination__btn wf-pagination__step"
          disabled={pageIndex <= 1}
          aria-label={t('ui.pagination.prev')}
          onClick={() => go(pageIndex - 1)}
        >
          <ChevronLeft size={14} className="wf-flip-rtl" />
        </button>
        {pageWindow(pageIndex, totalPages).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="wf-pagination__gap">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              aria-current={p === pageIndex ? 'page' : undefined}
              className={cn('wf-pagination__btn', p === pageIndex && 'is-current')}
              onClick={() => go(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="wf-pagination__btn wf-pagination__step"
          disabled={pageIndex >= totalPages}
          aria-label={t('ui.pagination.next')}
          onClick={() => go(pageIndex + 1)}
        >
          <ChevronRight size={14} className="wf-flip-rtl" />
        </button>
      </div>
    </nav>
  );
}

// ───────────────────────── Table ─────────────────────────

export interface TableColumn<R = any> {
  key: string;
  header?: ReactNode;
  render?: (record: R, rowKey: string, recordIndex: number) => ReactNode;
  width?: number | string;
  minWidth?: number;
  align?: 'left' | 'center' | 'right';
  fixed?: 'left' | 'right';
  className?: string;
}

interface AutotipOptions {
  isLoading?: boolean;
  isError?: boolean;
  emptyText?: ReactNode;
  loadingText?: ReactNode;
  onRetry?: () => void;
}
interface ScrollableOptions {
  minWidth?: number;
  maxHeight?: number | string;
}
interface ExpandableOptions<R = any> {
  expandedKeys: string[];
  onExpandedKeysChange: (keys: string[], context: { event?: React.SyntheticEvent; operateKey: string; operateType: 'expand' | 'collapse' }) => void;
  render: (record: R, rowKey: string, recordIndex: number) => ReactNode;
  /** Return false to hide the toggle for a row. */
  shouldRecordExpandable?: (record: R, rowKey: string, recordIndex: number) => boolean;
}

export type TableAddon =
  | { kind: 'autotip'; options: AutotipOptions }
  | { kind: 'scrollable'; options: ScrollableOptions }
  | { kind: 'expandable'; options: ExpandableOptions };

const addons = {
  autotip: (options: AutotipOptions): TableAddon => ({ kind: 'autotip', options }),
  scrollable: (options: ScrollableOptions): TableAddon => ({ kind: 'scrollable', options }),
  expandable: <R,>(options: ExpandableOptions<R>): TableAddon => ({ kind: 'expandable', options: options as ExpandableOptions }),
};

export interface TableProps<R = any> {
  records: R[];
  recordKey: string | ((record: R, index: number) => string);
  columns: TableColumn<R>[];
  addons?: TableAddon[];
  bordered?: boolean;
  /** Top-align cell content (default is vertically centered). */
  verticalTop?: boolean;
  compact?: boolean;
  onRowClick?: (record: R, rowKey: string, event: React.MouseEvent) => void;
  rowClassName?: (record: R, index: number) => string | undefined;
  className?: string;
  style?: CSSProperties;
}

function getRowKey<R>(record: R, index: number, recordKey: TableProps<R>['recordKey']): string {
  if (typeof recordKey === 'function') return recordKey(record, index);
  const v = (record as Record<string, unknown>)?.[recordKey];
  return v === undefined || v === null ? String(index) : String(v);
}

function TableRoot<R>({
  records,
  recordKey,
  columns,
  addons: addonList = [],
  bordered,
  verticalTop,
  compact,
  onRowClick,
  rowClassName,
  className,
  style,
}: TableProps<R>) {
  const { t } = useTranslation();
  const autotip = addonList.find((a) => a.kind === 'autotip')?.options as AutotipOptions | undefined;
  const scroll = addonList.find((a) => a.kind === 'scrollable')?.options as ScrollableOptions | undefined;
  const expand = addonList.find((a) => a.kind === 'expandable')?.options as ExpandableOptions<R> | undefined;
  const colCount = columns.length + (expand ? 1 : 0);

  const toggle = (key: string, e: React.SyntheticEvent) => {
    if (!expand) return;
    const isOpen = expand.expandedKeys.includes(key);
    const next = isOpen ? expand.expandedKeys.filter((k) => k !== key) : [...expand.expandedKeys, key];
    expand.onExpandedKeysChange(next, { event: e, operateKey: key, operateType: isOpen ? 'collapse' : 'expand' });
  };

  let tip: ReactNode = null;
  if (autotip?.isLoading && records.length === 0) {
    tip = <StatusTip status="loading" loadingText={autotip.loadingText} />;
  } else if (autotip?.isError) {
    tip = <StatusTip status="error" onRetry={autotip.onRetry} />;
  } else if (records.length === 0) {
    tip = <StatusTip status="empty" emptyText={autotip?.emptyText ?? t('ui.empty')} />;
  }

  return (
    <div
      className={cn(
        'wf-table',
        bordered && 'wf-table--bordered',
        verticalTop && 'wf-table--top',
        compact && 'wf-table--compact',
        autotip?.isLoading && records.length > 0 && 'is-refreshing',
        className,
      )}
      style={style}
    >
      <div className="wf-table__scroll" style={{ maxHeight: scroll?.maxHeight }}>
        <table style={{ minWidth: scroll?.minWidth }}>
          <colgroup>
            {expand && <col style={{ width: 40 }} />}
            {columns.map((c) => (
              <col key={c.key} style={{ width: c.width, minWidth: c.minWidth }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {expand && <th className="wf-table__expand-cell" aria-label="expand" />}
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(c.align && `is-${c.align}`, c.fixed && `is-fixed-${c.fixed}`, c.className)}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tip ? (
              <tr className="wf-table__tip-row">
                <td colSpan={colCount}>{tip}</td>
              </tr>
            ) : (
              records.map((record, index) => {
                const key = getRowKey(record, index, recordKey);
                const canExpand = expand && (expand.shouldRecordExpandable?.(record, key, index) ?? true);
                const isOpen = !!expand?.expandedKeys.includes(key);
                return (
                  <Fragment key={key}>
                    <tr
                      className={cn(onRowClick && 'is-clickable', isOpen && 'is-expanded', rowClassName?.(record, index))}
                      onClick={onRowClick ? (e) => onRowClick(record, key, e) : undefined}
                    >
                      {expand && (
                        <td className="wf-table__expand-cell">
                          {canExpand && (
                            <button
                              type="button"
                              className={cn('wf-table__expand-btn', isOpen && 'is-open')}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? t('ui.collapse') : t('ui.expand')}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(key, e);
                              }}
                            >
                              <ChevronRight size={14} className="wf-flip-rtl" />
                            </button>
                          )}
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(c.align && `is-${c.align}`, c.fixed && `is-fixed-${c.fixed}`, c.className)}
                        >
                          {c.render ? c.render(record, key, index) : ((record as Record<string, ReactNode>)[c.key] ?? '')}
                        </td>
                      ))}
                    </tr>
                    {isOpen && expand && (
                      <tr className="wf-table__expanded-row">
                        <td colSpan={colCount}>{expand.render(record, key, index)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionPanel({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('wf-table__action-panel', className)}>{children}</div>;
}

export const Table = Object.assign(TableRoot, { ActionPanel, addons });
