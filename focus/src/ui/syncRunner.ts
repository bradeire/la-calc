import { useEffect } from 'react';
import { useApp, useSettings } from './hooks';

/**
 * Keeps sync running in the background: shortly after start, every minute, a few seconds after
 * local changes, and when the app comes back to the foreground. Problems are shown in Settings.
 */
export function useSyncRunner() {
  const app = useApp();
  const { onboarded } = useSettings();
  useEffect(() => {
    if (!onboarded || app.platform.kind === 'memory') return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // Keep Android's background job in step with whether sync is on.
    let scheduled: boolean | null = null;
    const schedule = () => {
      const on = app.sync.status().enabled;
      if (!app.platform.backgroundSync || on === scheduled) return;
      scheduled = on;
      void app.platform.backgroundSync(on).catch(() => {
        scheduled = null;
      });
    };
    const run = () => {
      schedule();
      if (!app.sync.status().enabled) return;
      void app.sync.syncNow().catch(() => {});
    };
    const first = setTimeout(run, 2000);
    const every = setInterval(run, 60_000);
    const unsubscribe = app.repos.db.subscribe(() => {
      if (!app.sync.status().enabled || app.sync.status().pending === 0) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 3000);
    });
    const onVisible = () => document.visibilityState === 'visible' && run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
    };
  }, [app, onboarded]);
}
