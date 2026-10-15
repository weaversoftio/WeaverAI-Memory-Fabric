/**
 * ConsoleLayout - main layout shell.
 *
 *   ┌──────────┬──────────────────────────────┐
 *   │          │ GlobalHeader                 │
 *   │  Sider   ├──────────────────────────────┤
 *   │ (brand + │ TabBar                       │
 *   │   nav)   ├──────────────────────────────┤
 *   │          │ page content (scrolls)       │
 *   └──────────┴──────────────────────────────┘
 *
 * Contains business logic such as TabBar, routing and role-based menu filtering.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Tooltip, cn } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { usePanelAnalyticsEnabled, useAnalyticsChConfigured } from '@/services/usePanelCapabilities';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { ITEM_ICON, usePageMeta, GROUP_ORDER_KEYS, type PageId } from '@/constants/menu';

/** Route path -> PageId */
const PATH_TO_PAGE: Record<string, PageId> = {
  '/': 'workbench_board',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/analytics': 'analytics',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId -> route path */
const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path]),
) as Record<PageId, string>;

const SIDER_COLLAPSED_KEY = 'wamf-panel.sider-collapsed';

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDER_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function ConsoleLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();
  const PAGE_META = usePageMeta();

  const activePage: PageId = useMemo(() => {
    const match = Object.entries(PATH_TO_PAGE).find(
      ([path]) => path !== '/' && location.pathname.startsWith(path),
    );
    return match ? match[1] : 'workbench_board';
  }, [location.pathname]);

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The usage guide page is standalone (has its own back button and header) and does not occupy the multi-tab bar
  const isGuide = location.pathname === '/guide';

  const [openPages, setOpenPages] = useState<PageId[]>(() => (isGuide ? [] : [activePage]));

  useEffect(() => {
    // The standalone /guide page does not append pages like workbench_board to the tab bar, to avoid an extra tab when going back
    if (isGuide) return;
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage, isGuide]);

  const [siderCollapsed, setSiderCollapsed] = useState(readCollapsed);
  const toggleSider = () => {
    setSiderCollapsed((prev) => {
      try {
        window.localStorage.setItem(SIDER_COLLAPSED_KEY, prev ? '0' : '1');
      } catch {
        // Preference is optional
      }
      return !prev;
    });
  };

  // First-use guide: after login, pop up automatically on a "first time per user" basis
  const currentUserId = auth?.user_id;
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) {
      setOnboardingVisible(true);
    }
  }, [currentUserId]);

  /**
   * Review guide: clear the onboarded flag + set the Guide visible again.
   * The flag must be cleared before setVisible, otherwise the Guide's internal close -> markOnboarded chain
   * would immediately mark it as seen again.
   *
   * The entry point is kept only at the bottom of the "Usage guide" page (GuidePage fires the wamf-replay-onboarding event).
   */
  const handleReplayOnboarding = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);

  // The "Guide replay" at the bottom of GuidePage triggers the review guide via a custom event
  useEffect(() => {
    const onReplay = () => handleReplayOnboarding();
    window.addEventListener('wamf-replay-onboarding', onReplay);
    return () => window.removeEventListener('wamf-replay-onboarding', onReplay);
  }, [handleReplayOnboarding]);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = PAGE_TO_PATH[id];
      if (path) navigate(path);
    },
    [navigate],
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        const next = prev.filter((p) => p !== id);
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo],
  );

  // ===== Menu filtering based on team role =====
  // admin can access all pages (including resource management)
  // The "Member management" item: not visible to reviewer
  //
  // The "Observability" (analytics) entry converges across three layers (hidden if any is missing):
  //   1. Visible only to system_admin (useCurrentRole() === 'admin')
  //   2. Panel env switch PANEL_FEATURE_ANALYTICS_ENABLED (off by default, delivered via the
  //      capabilities of /meta/instances; when the switch is off no CH probe is issued)
  //   3. Runtime CH probe: auto-hide when the kernel has not configured analytics ClickHouse
  //      (keep showing while probing, hide after confirming it is not configured, to avoid flicker)
  const analyticsSwitchOn = usePanelAnalyticsEnabled();
  const analyticsChConfigured = useAnalyticsChConfigured(analyticsSwitchOn === true);
  const analyticsVisible = analyticsSwitchOn === true && analyticsChConfigured !== false;

  const menuGroups = useMemo(() => {
    const byGroup = new Map<string, (typeof PAGE_META)[PageId][]>();

    for (const meta of Object.values(PAGE_META)) {
      if (userRole === 'reviewer' && meta.id === 'team_members') continue;
      // "Observability" is visible only to system_admin, and requires the panel switch on + the kernel having CH configured
      if (meta.id === 'analytics') {
        if (userRole !== 'admin' || !analyticsVisible) continue;
      }
      const list = byGroup.get(meta.group) ?? [];
      list.push(meta);
      byGroup.set(meta.group, list);
    }

    return GROUP_ORDER_KEYS.map((key) => t(`menu.group.${key}`))
      .filter((g) => byGroup.has(g))
      .map((g) => ({
        title: g,
        items: byGroup.get(g)!.sort((a, b) => a.order - b.order),
      }));
  }, [userRole, PAGE_META, t, analyticsVisible]);

  const workbenchGroupTitle = t('menu.group.workbench');
  const pinnedGroup = menuGroups.find((g) => g.title === workbenchGroupTitle);
  const restGroups = menuGroups.filter((g) => g.title !== workbenchGroupTitle);

  const renderMenuItem = (item: (typeof PAGE_META)[PageId]) => {
    const isActive = activePage === item.id;
    const link = (
      <button
        type="button"
        className={cn('wf-nav__item', isActive && 'is-active')}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => navigateTo(item.id)}
      >
        <span className="wf-nav__icon">{ITEM_ICON[item.id]}</span>
        <span className="wf-nav__label">{item.label}</span>
      </button>
    );
    return (
      <li key={item.id}>
        {siderCollapsed ? (
          <Tooltip title={item.label} placement="right">
            {link}
          </Tooltip>
        ) : (
          link
        )}
      </li>
    );
  };

  return (
    <div className={cn('wf-shell', siderCollapsed && 'is-sider-collapsed')}>
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />

      <aside className="wf-sider" aria-label={t('header.brand')}>
        <div className="wf-sider__brand _memory-global-header-brand">
          <img src="/logo.png" alt="" className="wf-sider__logo" />
          <div className="wf-sider__wordmark">
            <span className="wf-sider__wordmark-top">WeaverAI</span>
            <span className="wf-sider__wordmark-bottom">Memory Fabric</span>
          </div>
        </div>

        <nav className="wf-nav">
          {pinnedGroup && <ul className="wf-nav__list">{pinnedGroup.items.map(renderMenuItem)}</ul>}
          {restGroups.map((group) => (
            <div key={group.title} className="wf-nav__group">
              <div className="wf-nav__group-title">{group.title}</div>
              <ul className="wf-nav__list">{group.items.map(renderMenuItem)}</ul>
            </div>
          ))}
        </nav>

        <div className="wf-sider__footer">
          <Tooltip title={siderCollapsed ? t('layout.sider.expand') : undefined} placement="right">
            <button
              type="button"
              className="wf-sider__toggle"
              aria-label={siderCollapsed ? t('layout.sider.expand') : t('layout.sider.collapse')}
              onClick={toggleSider}
            >
              {siderCollapsed ? (
                <PanelLeftOpen size={16} className="wf-flip-rtl" />
              ) : (
                <PanelLeftClose size={16} className="wf-flip-rtl" />
              )}
              <span className="wf-nav__label">{t('layout.sider.collapse')}</span>
            </button>
          </Tooltip>
        </div>
      </aside>

      <div className="wf-main">
        <GlobalHeader
          userRole={userRole}
          currentUser={auth?.user ?? ''}
          currentUserId={auth?.user_id}
          instanceName={auth?.instance_name}
          onLogout={logout}
        />
        {!isGuide && (
          <TabBar pages={openPages} activePage={activePage} onNavigate={navigateTo} onClose={closePage} />
        )}
        <div className="wf-content _memory-content-body">
          {/* key bound to pathname: remount the page frame on route change to trigger the _page-enter transition and keep cross-page continuity */}
          <main key={location.pathname} className="_memory-page-frame">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
