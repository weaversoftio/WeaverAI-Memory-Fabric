/**
 * DrillDownDrawer - unified drill-down drawer.
 *
 * Replaces the former interaction of "click a card/row -> set a page-level filter -> scroll down to the table to see results":
 * drill-down results are shown directly inside the drawer, without requiring the user to scroll and locate them, and without changing the main page state.
 *
 * Data loading is strictly bound to visible: when the drawer is closed, both hooks have enabled = false,
 * so no background requests are made; when switching Tab only the current view is loaded.
 *
 * wiki / codegraph both belong to knowledge-service and bridge_source cannot distinguish them - when drilling down into these two
 * categories the drawer shows a hint that the result includes all knowledge calls (kernel filter dimension limitation).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Drawer, TabPanel, Tabs, Text } from 'tea-component';
import type { AnalyticsRangeDays } from '@/lib/api/analytics';
import { categoryToBridgeSource } from './AssetCategoryCards';
import { TraceDetailList } from './TraceDetailList';
import { UsageDetailList } from './UsageDetailList';
import { useCallDetail } from '../hooks/useCallDetail';
import { useUsageList } from '../hooks/useUsageList';
import { drillViews, type DrillTarget, type DrillView } from '../utils/drill-target';

export function DrillDownDrawer({
  target,
  days,
  spaceId,
  resolveUserName,
  onClose,
}: {
  target: DrillTarget | null;
  days: AnalyticsRangeDays;
  spaceId: string;
  resolveUserName: (id: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const visible = target !== null;

  const views = useMemo<DrillView[]>(() => (target ? drillViews(target) : ['trace']), [target]);
  const [view, setView] = useState<DrillView>(views[0]);

  // When switching the drill-down target, reset to that target's default view (the previous target's view may not apply)
  useEffect(() => {
    setView(views[0]);
  }, [views]);

  const userId = target?.type === 'member' ? target.userId : undefined;
  const modelId = target?.type === 'model' ? target.modelId : undefined;
  const bridgeSource =
    target?.type === 'category' ? categoryToBridgeSource(target.category) : undefined;

  const trace = useCallDetail({
    enabled: visible && view === 'trace',
    days,
    spaceId,
    userId: userId ?? null,
    bridgeSource,
    endpointFilter: '',
  });

  const usage = useUsageList({
    enabled: visible && view === 'usage',
    days,
    spaceId,
    userId,
    modelId,
  });

  const title = useMemo(() => {
    if (!target) return '';
    switch (target.type) {
      case 'member':
        return resolveUserName(target.userId);
      case 'category':
        return t(`analytics.category.${target.category}`);
      case 'model':
        return target.modelName || target.modelId;
    }
  }, [target, resolveUserName, t]);

  const subtitle = useMemo(() => {
    if (!target) return null;
    const raw =
      target.type === 'member'
        ? target.userId
        : target.type === 'model'
          ? target.modelId
          : t('analytics.drill.categoryHint');
    return (
      <span className="_an-drill-subtitle">
        <span className="_an-mono">{raw}</span>
        <Text theme="label">{t('analytics.range', { days })}</Text>
      </span>
    );
  }, [target, days, t]);

  const tabs = views.map((v) => ({ id: v, label: t(`analytics.drill.view.${v}`) }));

  // Under knowledge-service wiki / codegraph share bridge_source, so the result cannot contain only a single category
  const knowledgeAmbiguous =
    target?.type === 'category' && (target.category === 'wiki' || target.category === 'codegraph');

  const renderView = (v: DrillView) => {
    if (!target) return null;
    return v === 'trace' ? (
      <TraceDetailList
        rows={trace.rows}
        total={trace.total}
        offset={trace.offset}
        limit={trace.limit}
        loading={trace.loading}
        error={trace.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        onOffsetChange={trace.setOffset}
      />
    ) : (
      <UsageDetailList
        rows={usage.rows}
        total={usage.total}
        offset={usage.offset}
        limit={usage.limit}
        loading={usage.loading}
        error={usage.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        showModel={target.type !== 'model'}
        onOffsetChange={usage.setOffset}
      />
    );
  };

  return (
    <Drawer
      visible={visible}
      size="l"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      destroyOnClose
      showMask
    >
      {target && (
        <div className="_an-drill-body">
          {knowledgeAmbiguous && (
            <Alert type="info">{t('analytics.drill.knowledgeAmbiguous')}</Alert>
          )}

          {views.length > 1 ? (
            <Tabs tabs={tabs} activeId={view} onActive={(tab) => setView(tab.id as DrillView)}>
              {views.map((v) => (
                <TabPanel id={v} key={v}>
                  <div className="_an-drill-tab-body">{renderView(v)}</div>
                </TabPanel>
              ))}
            </Tabs>
          ) : (
            renderView(view)
          )}
        </div>
      )}
    </Drawer>
  );
}
