import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AppContainer } from '@/app/container';
import { useApp, useSettings } from './hooks';

/** Status of the local API, shared between the runner (AppShell) and Settings. */
export interface LocalApiStatus {
  state: 'off' | 'starting' | 'running' | 'error';
  address?: string;
  error?: string;
  recent: { at: string; method: string; path: string; status: number }[];
}

let status: LocalApiStatus = { state: 'off', recent: [] };
const subs = new Set<() => void>();
const set = (s: Partial<LocalApiStatus>) => {
  status = { ...status, ...s };
  for (const f of subs) f();
};
let tokenVersion = 0;

export function useLocalApiStatus(): LocalApiStatus {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => status,
    () => status,
  );
}

export const API_TOKEN_KEY = 'api:token';

function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The API token, created on first use. Kept in the OS keychain, never in the database. */
export async function getApiToken(app: AppContainer): Promise<string> {
  const existing = await app.platform.secrets.get(API_TOKEN_KEY);
  if (existing) return existing;
  const t = newToken();
  await app.platform.secrets.set(API_TOKEN_KEY, t);
  return t;
}

/** Replace the token: every client must be given the new one. */
export async function regenerateApiToken(app: AppContainer): Promise<string> {
  const t = newToken();
  await app.platform.secrets.set(API_TOKEN_KEY, t);
  tokenVersion++;
  set({});
  return t;
}

/** Starts/stops the server to match Settings and answers forwarded requests. */
export function useLocalApiRunner() {
  const app = useApp();
  const s = useSettings();
  const cfg = s.localApi;
  const approved = useRef(cfg.approvedAutomations);
  approved.current = cfg.approvedAutomations;
  const version = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => tokenVersion,
    () => tokenVersion,
  );

  useEffect(() => {
    const api = app.platform.localApi;
    if (!api || !s.onboarded || !cfg.enabled) {
      set({ state: 'off', address: undefined, error: undefined });
      return;
    }
    let alive = true;
    const unlisten = api.onRequest((req) => {
      const reply = app.api.handle(req, approved.current);
      set({ recent: [{ at: new Date().toISOString(), method: req.method, path: req.path, status: reply.status }, ...status.recent].slice(0, 20) });
      void api.respond(req.id, reply.status, JSON.stringify(reply.body));
    });
    set({ state: 'starting', error: undefined });
    void (async () => {
      try {
        const token = await getApiToken(app);
        const address = await api.start(cfg.port, token, cfg.allowLan);
        if (alive) set({ state: 'running', address });
      } catch (err) {
        if (alive) set({ state: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      alive = false;
      unlisten();
      void api.stop();
    };
  }, [app, s.onboarded, cfg.enabled, cfg.port, cfg.allowLan, version]);
}
