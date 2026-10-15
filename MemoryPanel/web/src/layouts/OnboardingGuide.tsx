/**
 * OnboardingGuide - first-use guide (Tea Guide component version)
 *
 * Uses the tea-component `Guide` to highlight page elements step by step, replacing the old full-screen two-column guide.
 *
 * Dual-role SOP (switching steps automatically navigates to the matching page, not just displays it):
 *   - Admin: login identity -> create/switch team -> create member and issue user_key -> Agent -> click Agent to bind assets -> four asset pages
 *   - Member: login identity -> invite members -> Agent -> click Agent to bind assets -> User_Key management -> four asset pages
 *
 * Admin and Member have the same Agent / asset capabilities (both can edit); the only difference is member management:
 * a member cannot create user accounts and can only invite existing users by user_id; an admin can create users and issue
 * user_keys, and can also create teams. The asset steps visit the Wiki / Code / Skill / Chat Memory pages one by one.
 *
 * Robustness: if a step's element selector is missing on the target page (e.g. a member lacks the "Add member" permission),
 * it falls back to the global Header brand area so the Guide does not vanish entirely due to a missing element.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Guide, type GuideStep } from 'tea-component';

const STORAGE_PREFIX = 'wamf-panel.onboarded';

/** Global always-present anchor element (Header brand area), used as fallback when the target element is missing */
const FALLBACK_SELECTOR = '._memory-global-header-brand';

/** Per-user localStorage key for "guide already seen" */
function onboardedKey(userId?: string): string {
  return `${STORAGE_PREFIX}.${userId || 'anonymous'}`;
}

/** Whether the guide should pop up automatically (not yet marked = first visit) */
export function shouldShowOnboarding(userId?: string): boolean {
  try {
    return window.localStorage.getItem(onboardedKey(userId)) !== '1';
  } catch {
    // Do not bother the user when localStorage is unavailable
    return false;
  }
}

/**
 * Reset the "guide already seen" flag.
 *
 * Triggered manually by the user via "My profile -> Review guide": clears the onboarded flag; the next time the main panel is entered,
 * the useEffect sees shouldShowOnboarding() === true and pops the guide up again.
 *
 * Note: the caller must also set OnboardingGuide's visible back to true, because the earlier close()
 * already advanced the internal current to -1 and called onClose; clearing the flag alone is not enough to reopen it.
 */
export function resetOnboarding(userId?: string): void {
  try {
    window.localStorage.removeItem(onboardedKey(userId));
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

function markOnboarded(userId?: string): void {
  try {
    window.localStorage.setItem(onboardedKey(userId), '1');
  } catch {
    /* Silently ignore when localStorage is unavailable */
  }
}

interface OnboardingStep {
  /** Target route: navigate automatically when switching steps (omitted = stay on the current page) */
  path?: string;
  /**
   * Selector of the element to highlight. Supports an array for ordered fallback (e.g. admin prefers highlighting the "Add member" button,
   * falling back to the member list area if the button is missing); if all are missing, falls back to the Header brand area.
   */
  selector: string | string[];
  placement?: GuideStep['placement'];
  titleKey: string;
  descKey: string;
}

/** Return the first matching element in order; return null if none is found */
function firstMatch(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Resolve the step's highlight element; fall back in order when the target is missing, finally to the global Header brand area so the Guide can always render */
function resolveElement(selector: string | string[]): Element {
  const list = Array.isArray(selector) ? selector : [selector];
  return firstMatch(list) || document.querySelector(FALLBACK_SELECTOR) || document.body;
}

/**
 * Compute the bubble's expand direction dynamically from the element's actual position in the viewport:
 *   - Horizontal: element center in the left half -> expand right (*-start); right half -> expand left (*-end)
 *   - Vertical: element center in the top half -> expand down (bottom-*); bottom half -> expand up (top-*)
 * This way the bubble always expands toward the viewport center, so no element at any page/position pushes it off screen.
 */
function computePlacement(
  selector: string | string[],
  fallback: GuideStep['placement'],
): GuideStep['placement'] {
  const list = Array.isArray(selector) ? selector : [selector];
  const el = firstMatch(list);
  // When the element is missing (page not navigated/rendered) the direction cannot be inferred from position; use the step's preset safe direction.
  // Never fall back to computing from body: the body rect height far exceeds the viewport, so cy is always greater than innerHeight/2,
  // which would yield top-* and place the bubble off screen (the root cause of "box overflows the screen and cannot be clicked").
  if (!el) return fallback;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const horizontal = cx < window.innerWidth / 2 ? 'start' : 'end';
  const vertical = cy < window.innerHeight / 2 ? 'bottom' : 'top';
  const placement = `${vertical}-${horizontal}`;
  if (
    placement === 'bottom-start' ||
    placement === 'bottom-end' ||
    placement === 'top-start' ||
    placement === 'top-end'
  ) {
    return placement;
  }
  return fallback;
}

/**
 * Guide step for clicking an Agent to open the edit dialog and bind assets (shared by Admin / Member,
 * right after the "New Agent" step, same-page switch with no navigation).
 * Three-level anchor fallback:
 *   1. Card view: box the whole card of the first editable Agent;
 *   2. List view (no cards): fall back to the name button of an editable Agent;
 *   3. The user has no Agent yet: fall back to the "New Agent" button,
 *      with copy that says "create an Agent first, then come back and click it".
 */
const AGENT_BIND_STEP: OnboardingStep = {
  path: '/team/agents',
  selector: [
    '[data-guide="agent-card-editable"]',
    '[data-guide="agent-name-editable"]',
    '[data-guide="create-agent"]',
  ],
  placement: 'bottom-start',
  titleKey: 'onboarding.guide.agentBind.title',
  descKey: 'onboarding.guide.agentBind.desc',
};

/** Guide steps where each asset page is visited and introduced (Wiki / Code / Skill / Chat Memory) */
const ASSET_STEPS: OnboardingStep[] = [
  {
    path: '/wiki',
    // Prefer boxing the "New Wiki" button; if it is missing (pinned asset tab / no team), fall back to the top Wiki tab,
    // rather than the logo, to avoid boxing the wrong area.
    selector: ['[data-guide="create-wiki"]', '[data-guide="tab-wiki"]'],
    // ActionPanel left "New Wiki" button: expand right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.wiki.title',
    descKey: 'onboarding.guide.asset.wiki.desc',
  },
  {
    path: '/code',
    // Prefer boxing the "Register repository" button; if missing, fall back to the top Code tab.
    selector: ['[data-guide="create-code"]', '[data-guide="tab-code"]'],
    // ActionPanel left "Register repository" button: expand right
    placement: 'bottom-start',
    titleKey: 'onboarding.guide.asset.code.title',
    descKey: 'onboarding.guide.asset.code.desc',
  },
  {
    path: '/skills',
    selector: '[data-guide="import-skill"]',
    // "Import Skill" button in the page header's right-side actions (same as Memory): expand left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.skill.title',
    descKey: 'onboarding.guide.asset.skill.desc',
  },
  {
    path: '/memory',
    selector: '[data-guide="import-memory"]',
    // Right-side "Import memory" button: expand left
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.asset.memory.title',
    descKey: 'onboarding.guide.asset.memory.desc',
  },
];

function buildSteps(role: 'admin' | 'member'): OnboardingStep[] {
  const loginStep: OnboardingStep = {
    selector: '._memory-global-header-user-btn',
    // Top-right user button of the header: use bottom-end so the bubble's right edge aligns with the element's right edge and expands left,
    // avoiding the bubble clipping the "Next" button on narrow viewports
    placement: 'bottom-end',
    titleKey: 'onboarding.guide.login.title',
    descKey: 'onboarding.guide.login.desc',
  };

  // Admin and Member have the same Agent / asset capabilities (both can edit); only member management differs:
  //   - admin: can create teams, create users and issue user_keys (member lacks this permission)
  //   - member: can only invite existing users into the team by user_id; but can manage their own User_Key (admin has no such entry)
  // placement choice: right-side elements use bottom-end (expand left), left-side elements use bottom-start (expand right)
  if (role === 'admin') {
    return [
      loginStep,
      {
        selector: '._memory-team-switcher-trigger',
        // Top-left of header: expand left to avoid overflowing on the right
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.team.title',
        descKey: 'onboarding.guide.team.desc',
      },
      {
        path: '/team/members',
        // Prefer highlighting the "Add member" button; with no team the button does not exist, so fall back to the member list area
        selector: ['[data-guide="add-member"]', '[data-guide="members-list"]'],
        placement: 'bottom-end',
        titleKey: 'onboarding.guide.memberAdmin.title',
        descKey: 'onboarding.guide.memberAdmin.desc',
      },
      {
        path: '/team/agents',
        selector: '[data-guide="create-agent"]',
        // ActionPanel left "New Agent" button: expand right
        placement: 'bottom-start',
        titleKey: 'onboarding.guide.agent.title',
        descKey: 'onboarding.guide.agent.desc',
      },
      AGENT_BIND_STEP,
      ...ASSET_STEPS,
    ];
  }

  return [
    loginStep,
    {
      path: '/team/members',
      // A regular member has no "Add member" button (visible only to admin/teamAdmin),
      // so highlight the always-present member list area, avoiding a fallback to the header that causes "no navigation / wrong position"
      selector: '[data-guide="members-list"]',
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.member.title',
      descKey: 'onboarding.guide.member.desc',
    },
    {
      path: '/team/agents',
      selector: '[data-guide="create-agent"]',
      // ActionPanel left "New Agent" button: expand right
      placement: 'bottom-start',
      titleKey: 'onboarding.guide.agent.title',
      descKey: 'onboarding.guide.agent.desc',
    },
    AGENT_BIND_STEP,
    {
      path: '/team/api-keys',
      selector: '[data-guide="create-key"]',
      // Justify right "New Key" button: expand left
      placement: 'bottom-end',
      titleKey: 'onboarding.guide.apikey.title',
      descKey: 'onboarding.guide.apikey.desc',
    },
    ...ASSET_STEPS,
  ];
}

export function OnboardingGuide({
  visible,
  userId,
  userRole,
  onClose,
}: {
  visible: boolean;
  userId?: string;
  userRole: 'admin' | 'member' | 'reviewer' | null;
  /** Close the guide (both "Skip" and "Finish" mark it as seen) */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const isAdmin = userRole === 'admin';
  const steps = useMemo(() => buildSteps(isAdmin ? 'admin' : 'member'), [isAdmin]);

  const [current, setCurrent] = useState(-1);
  const pendingRef = useRef<number | null>(null);

  /**
   * Animation alignment strategy (replaces the old "hide -> show" gating, eliminating the mask-less gap):
   *   - Same-page switch: the bubble (popper transform) and highlight box (top/left/width/height) carry
   *     CSS transitions and glide to the new position with the scrollIntoView smooth scroll, visible throughout;
   *   - Cross-page switch: the old anchor unmounts with the page (popper positions detached elements at 0,0),
   *     so fadeOut -> navigate -> once the new anchor is ready, snap into place with no-anim -> fadeIn.
   */
  const fadeOut = useCallback(() => {
    document.body.classList.add('_guide-fading');
  }, []);

  /** Fade in after the new step's first-frame positioning completes (double rAF: wait for React commit + popper positioning) */
  const fadeIn = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('_guide-fading');
        document.body.classList.remove('_guide-no-anim');
      });
    });
  }, []);

  // Clean up the global class on unmount
  useEffect(() => {
    return () => {
      document.body.classList.remove('_guide-fading');
      document.body.classList.remove('_guide-no-anim');
    };
  }, []);

  const close = useCallback(() => {
    markOnboarded(userId);
    pendingRef.current = null;
    document.body.classList.remove('_guide-fading');
    document.body.classList.remove('_guide-no-anim');
    setCurrent(-1);
    onClose();
  }, [userId, onClose]);

  // Step switching: finish/cancel close directly; next/back/start first navigate to the target page,
  // and only advance current once the target path matches and the element appears (so the Guide does not flash away on a missing element).
  const handleCurrentChange = useCallback(
    (next: number, context: { from: 'start' | 'back' | 'next' | 'finish' | 'cancel' }) => {
      const { from } = context;
      if (from === 'finish' || from === 'cancel') {
        close();
        return;
      }
      if (next < 0 || next >= steps.length) return;
      const target = steps[next];
      if (!target) return;
      if (target.path && target.path !== location.pathname) {
        // Cross-page navigation: fade out first (covers the "anchor unmount -> new page load" window), fade in after pending completes
        fadeOut();
        pendingRef.current = next;
        navigate(target.path);
      } else {
        // Same-page switch: advance directly; the position transition aligns with the scroll animation and glides over smoothly
        setCurrent(next);
      }
    },
    [steps, location.pathname, navigate, close, fadeOut],
  );

  // Wait for navigation to finish: after the path matches, poll for the target element to appear, then advance current (wait at most 60 frames, about 1s)
  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    const target = steps[pending];
    if (!target || !target.path) return;
    if (location.pathname !== target.path) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // selector may be a fallback array: any element appearing means the target page is ready
      const list = Array.isArray(target.selector) ? target.selector : [target.selector];
      if (firstMatch(list) || tries >= 60) {
        pendingRef.current = null;
        // New anchor snaps into place (no-anim disables the transition to avoid sliding in from the old position), then fades in
        document.body.classList.add('_guide-no-anim');
        setCurrent(pending);
        fadeIn();
        return;
      }
      tries += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, steps, fadeIn]);

  // First display: disable transitions before popper's first-frame positioning (so the bubble does not slide in from (0,0)), enable after positioning completes
  useEffect(() => {
    if (!visible) return;
    document.body.classList.add('_guide-no-anim');
    const timer = window.setTimeout(() => {
      document.body.classList.remove('_guide-no-anim');
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.body.classList.remove('_guide-no-anim');
    };
  }, [visible]);
  const guideSteps: GuideStep[] = useMemo(
    () =>
      steps.map((s) => ({
        element: () => resolveElement(s.selector),
        placement: computePlacement(s.selector, s.placement),
        title: t(s.titleKey),
        description: t(s.descKey),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, t, current, visible],
  );

  const startContent: GuideStep = useMemo(
    () => ({
      element: () => resolveElement(FALLBACK_SELECTOR),
      // Welcome page highlights the header brand area: compute direction dynamically from the actual position
      placement: computePlacement(FALLBACK_SELECTOR, 'bottom-start'),
      title: t(
        isAdmin ? 'onboarding.guide.start.admin.title' : 'onboarding.guide.start.member.title',
      ),
      description: t(
        isAdmin ? 'onboarding.guide.start.admin.desc' : 'onboarding.guide.start.member.desc',
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAdmin, t, visible],
  );

  // ===== Custom precise highlight layer =====
  // The tea Guide's built-in mask is positioned by react-popper: under the inner scroll container (tea-layout__content)
  // it has a fixed offset (about 3~5px) and does not update on scroll (the offset grows after scrolling), so the highlight box
  // "leaks at the edges". Here we compute in real time with getBoundingClientRect (capture-listen to inner container scroll +
  // resize) and hide the Guide's own mask via global CSS (see index.css `.tea-overlay[style*="z-index: 9999"]`).
  const anchorSelector =
    current >= 0 && steps[current] ? steps[current].selector : FALLBACK_SELECTOR;
  const [anchorBox, setAnchorBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!visible) {
      setAnchorBox(null);
      return;
    }
    const update = () => {
      const el = resolveElement(anchorSelector);
      if (!el || el === document.body) return;
      const r = el.getBoundingClientRect();
      setAnchorBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    // At the moment of a step switch the Guide's scrollIntoView(smooth) animation may not have finished,
    // so an immediate measurement lands mid-animation; use rAF + a delayed fallback to correct once the layout settles.
    const raf = requestAnimationFrame(update);
    const late = window.setTimeout(update, 400);
    // Listen in the capture phase to catch scroll events of inner scroll containers (non-window)
    const onScrollOrResize = () => requestAnimationFrame(update);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    // Layout changes from data loading also move the anchor (ResizeObserver covers more cases than the resize event)
    const ro = new ResizeObserver(() => requestAnimationFrame(update));
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(late);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      ro.disconnect();
    };
  }, [visible, anchorSelector]);

  return (
    <>
      <Guide
        visible={visible}
        steps={guideSteps}
        startContent={startContent}
        current={current}
        onCurrentChange={handleCurrentChange}
        showBackButton
        showDot
        nextButtonTheme="primary"
        cancelText={t('onboarding.skip')}
        backText={t('onboarding.prev')}
        nextText={t('onboarding.next')}
        finishText={t('onboarding.finish')}
        startFinishText={t('onboarding.start')}
        autoScrollIntoView
      />
      {anchorBox && (
        <div className="_guide-mask" aria-hidden="true">
          {/* Four semi-transparent mask blocks (top/bottom/left/right) form the highlight hole */}
          <div
            className="_guide-mask-block"
            style={{ top: 0, left: 0, right: 0, height: anchorBox.top }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top + anchorBox.height, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="_guide-mask-block"
            style={{ top: anchorBox.top, left: 0, width: anchorBox.left, height: anchorBox.height }}
          />
          <div
            className="_guide-mask-block"
            style={{
              top: anchorBox.top,
              left: anchorBox.left + anchorBox.width,
              right: 0,
              height: anchorBox.height,
            }}
          />
          {/* Highlight outline */}
          <div
            className="_guide-mask-ring"
            style={{
              top: anchorBox.top,
              left: anchorBox.left,
              width: anchorBox.width,
              height: anchorBox.height,
            }}
          />
        </div>
      )}
    </>
  );
}
