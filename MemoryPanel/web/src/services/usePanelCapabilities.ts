/**
 * usePanelCapabilities / useAnalyticsChConfigured -- visibility decision for the "Observability" entry.
 *
 * Two conditions (both required):
 *   1. Panel env switch: PANEL_FEATURE_ANALYTICS_ENABLED (delivered via the capabilities of
 *      GET /meta/instances). Off by default -> the menu/route is not shown, and no CH probe request is sent.
 *   2. Runtime CH probe: once the switch is on, call GET /api/v1/analytics/config (panel transparent proxy
 *      -> kernel /v3/analytics/config). If ClickHouse is not configured the entry is hidden automatically.
 *
 * Probe results are cached at module level: the env switch does not change within a session; the CH probe goes through the same endpoint as
 * the in-page useAnalyticsMetrics probe of AnalyticsPage (analyticsApi dedupes internally via dedupeInFlight),
 * so no duplicate network requests are produced.
 */
import { useEffect, useState } from 'react';
import { metaInstancesApi } from '@/lib/api/meta-instances';
import { analyticsApi } from '@/lib/api/analytics';

/** env switch state cache (session-level, null = not yet obtained). */
let analyticsEnabledCache: boolean | null = null;

/**
 * Panel "Observability" env switch.
 * Returns null when not yet obtained (the renderer may treat it as invisible for now or keep the status quo);
 * false = switch off or fetch failed (conservatively hidden); true = switch on (the CH probe must still pass).
 */
export function usePanelAnalyticsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(analyticsEnabledCache);

  useEffect(() => {
    if (analyticsEnabledCache !== null) return;
    let alive = true;
    void metaInstancesApi
      .capabilities()
      .then((caps) => {
        analyticsEnabledCache = caps.analyticsEnabled;
        if (alive) setEnabled(caps.analyticsEnabled);
      })
      .catch(() => {
        // On fetch failure fall back to off (conservatively hidden, without blocking other panel features)
        analyticsEnabledCache = false;
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return enabled;
}

/**
 * Whether the kernel-side analytics ClickHouse is configured (runtime probe).
 * Initiated only when enabled=true; null = probing (the caller may treat it as "visible" for now and converge after the probe finishes).
 */
export function useAnalyticsChConfigured(enabled: boolean): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void analyticsApi
      .config()
      .then((cfg) => {
        if (alive) setConfigured(cfg.configured && cfg.reachable !== false);
      })
      .catch(() => {
        // On probe failure (network/permission) treat as not configured: the entry is hidden, and the in-page hint is handled by AnalyticsPage
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return configured;
}
