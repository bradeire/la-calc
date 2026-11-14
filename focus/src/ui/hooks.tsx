import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AppContainer } from '@/app/container';
import { todayISO, type DatePrefs } from '@/core/dates';
import type { Settings } from '@/data/repositories/settings';
import { NotFoundError, ValidationError, type UndoAction } from '@/services/events';
import { useUi } from '@/state/ui-store';

const AppCtx = createContext<AppContainer | null>(null);

export function AppProvider({ app, children }: { app: AppContainer; children: ReactNode }) {
  return <AppCtx.Provider value={app}>{children}</AppCtx.Provider>;
}

export function useApp(): AppContainer {
  const app = useContext(AppCtx);
  if (!app) throw new Error('useApp outside AppProvider');
  return app;
}

/** Database change counter; re-renders subscribers after each committed write. */
export function useDbVersion(): number {
  const app = useApp();
  const db = app.repos.db;
  return useSyncExternalStore(
    useCallback((cb) => db.subscribe(cb), [db]),
    () => db.version,
  );
}

/**
 * Run a synchronous repository read and re-run it whenever the database changes.
 * Reads are in-memory (ADR-003) so this is cheap.
 */
export function useQuery<T>(fn: () => T, deps: readonly unknown[]): T {
  const version = useDbVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, [version, ...deps]);
}

export function useSettings(): Settings {
  const app = useApp();
  return useQuery(() => app.repos.settings.getAll(), []);
}

export function useDatePrefs(): DatePrefs {
  const s = useSettings();
  return useMemo(() => ({ dateOrder: s.dateOrder, hour12: s.hour12, weekStartsOn: s.weekStartsOn }), [s.dateOrder, s.hour12, s.weekStartsOn]);
}

/** Today's date; updates at local midnight and when the app returns to the foreground. */
export function useToday(): string {
  const [today, setToday] = useState(() => todayISO());
  useEffect(() => {
    const check = () => setToday(todayISO());
    const now = new Date();
    const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000;
    const timer = setTimeout(check, msToMidnight);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [today]);
  return today;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof Error) return `Something went wrong: ${err.message}`;
  return 'Something went wrong';
}

function isUndo(v: unknown): v is UndoAction {
  return !!v && typeof v === 'object' && 'undo' in v && 'label' in v;
}

/**
 * Wrap a service call: shows an Undo toast for reversible actions and a clear
 * error toast for failures. Errors are logged, never swallowed silently.
 */
export function useAction() {
  const pushToast = useUi((s) => s.pushToast);
  return useCallback(
    <T,>(fn: () => T, opts: { success?: string } = {}): T | undefined => {
      try {
        const r = fn();
        if (isUndo(r)) {
          pushToast({
            message: r.label,
            action: {
              label: 'Undo',
              run: () => {
                try {
                  r.undo();
                } catch (err) {
                  console.error(err);
                  pushToast({ message: errorMessage(err), tone: 'error' });
                }
              },
            },
          });
        } else if (opts.success) pushToast({ message: opts.success, tone: 'success' });
        return r;
      } catch (err) {
        if (!(err instanceof ValidationError)) console.error(err);
        pushToast({ message: errorMessage(err), tone: 'error' });
        return undefined;
      }
    },
    [pushToast],
  );
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    useCallback(
      (cb) => {
        const m = window.matchMedia(q);
        m.addEventListener('change', cb);
        return () => m.removeEventListener('change', cb);
      },
      [q],
    ),
    () => window.matchMedia(q).matches,
  );
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
