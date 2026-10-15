/**
 * storage-utils.ts - shared foundation of the local demo data layer.
 *
 * Shared by agent-template-store / asset-scope-store / user-asset-store /
 * account-store / user-profile-store:
 *   - safeParse: fault-tolerant JSON.parse that falls back to a default value on parse failure;
 *   - emitChange / CHANGE_EVENT: after a write, broadcast a global event; together with
 *     useChangeNotifier it lets subscribers (the useXxx hooks) re-render automatically;
 *   - useChangeNotifier: a simple forceUpdate that listens to CHANGE_EVENT and the browser's
 *     native 'storage' event (cross-tab sync).
 *
 * These stores are all localStorage implementations for the frontend demo stage; once the backend is live they are replaced wholesale
 * with fetch, with no UI-layer changes needed.
 */

import { useEffect, useState } from 'react';

export const CHANGE_EVENT = 'wamf-memory.demo-store-change';

export function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function emitChange(): void {
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** Simple forceUpdate: increments after a localStorage / custom event fires. */
export function useChangeNotifier(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((v) => v + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange); // cross-tab sync
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return tick;
}
