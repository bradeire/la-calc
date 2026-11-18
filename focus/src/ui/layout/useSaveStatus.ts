import { useCallback, useSyncExternalStore } from 'react';
import { useApp } from '../hooks';

export function useSaveStatus() {
  const app = useApp();
  const saver = app.saver;
  const status = useSyncExternalStore(
    useCallback((cb) => saver.subscribe(cb), [saver]),
    () => saver.status,
  );
  return { status, error: saver.lastError?.message ?? null };
}
