import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrent as getCurrentLinks, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { MemorySecretStore } from './web';
import type { FileStore, HttpAdapter, LifecycleAdapter, LinkAdapter, LocalApiAdapter, NotificationAdapter, PersistenceAdapter, Platform, SecretStore } from './types';

/**
 * Native platform (Tauri 2). The SQLite image is a real file in the app-data
 * directory, written atomically by Rust (src-tauri/src/storage.rs). Bytes cross
 * the IPC bridge as raw binary bodies, not JSON arrays.
 */
const asBytes = (buf: ArrayBuffer) => (buf.byteLength ? new Uint8Array(buf) : null);

/**
 * Binary bodies for Rust. Android's WebView can't hand a raw request body to Rust, so Tauri
 * falls back to JSON there; send base64 (compact) instead of letting a Uint8Array become a
 * JSON array of numbers. Rust (lib.rs body_bytes) accepts both forms.
 */
const ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const binaryBody = (bytes: Uint8Array) => (ANDROID ? { b64: toBase64(bytes) } : bytes);

class TauriPersistence implements PersistenceAdapter {
  readonly name = 'SQLite file';
  async load() {
    return asBytes(await invoke<ArrayBuffer>('db_load'));
  }
  async loadPrevious() {
    return asBytes(await invoke<ArrayBuffer>('db_load_previous'));
  }
  async save(bytes: Uint8Array) {
    await invoke('db_save', binaryBody(bytes));
  }
  async saveSnapshot(name: string, bytes: Uint8Array) {
    await invoke('db_snapshot', binaryBody(bytes), { headers: { 'x-focus-name': name } });
  }
  async requestDurable() {
    return true; // App-data files are not subject to browser eviction.
  }
}

class TauriFileStore implements FileStore {
  async put(key: string, data: Blob) {
    await invoke('file_put', binaryBody(new Uint8Array(await data.arrayBuffer())), { headers: { 'x-focus-key': key } });
  }
  async get(key: string) {
    if (!(await invoke<boolean>('file_exists', { key }))) return null;
    return new Blob([await invoke<ArrayBuffer>('file_get', { key })]);
  }
  async delete(key: string) {
    await invoke('file_delete', { key });
  }
  async keys() {
    return invoke<string[]>('file_keys');
  }
}

/** Flush on backgrounding (mobile) and before the window closes (desktop). */
const tauriLifecycle: LifecycleAdapter = {
  onPause(cb) {
    const vis = () => document.visibilityState === 'hidden' && void cb();
    document.addEventListener('visibilitychange', vis);
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await cb();
        } finally {
          await getCurrentWindow().destroy();
        }
      })
      .then((u) => (unlisten = u))
      .catch((err: unknown) => console.warn('Close handler unavailable', err));
    return () => {
      document.removeEventListener('visibilitychange', vis);
      unlisten?.();
    };
  },
};

/**
 * OS notifications via the official plugin. Desktop notifications have no action
 * buttons, so Complete/Snooze happen in Focus's in-app reminder panel.
 */
const tauriNotifications: NotificationAdapter = {
  async permission() {
    return (await isPermissionGranted()) ? 'granted' : 'default';
  },
  async requestPermission() {
    const r = await requestPermission();
    return r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'default';
  },
  async show(n) {
    if (!(await isPermissionGranted())) return false;
    sendNotification({ title: n.title, body: n.body });
    return true;
  },
  onAction: () => () => {},
};

/** OS credential store via Rust (src-tauri/src/secrets.rs). */
const tauriSecrets: SecretStore = {
  persistent: true,
  get: (key) => invoke<string | null>('secret_get', { key }),
  set: (key, value) => invoke('secret_set', { key, value }),
  delete: (key) => invoke('secret_delete', { key }),
};

/** HTTP through Rust (src-tauri/src/http.rs) so the webview CSP stays strict and CORS does not apply. */
const tauriHttp: HttpAdapter = {
  request: (r) =>
    invoke('http_request', {
      request: { method: r.method, url: r.url, headers: Object.entries(r.headers ?? {}), body: r.body ?? null, timeout_ms: r.timeoutMs ?? null },
    }),
};

/**
 * focus:// links via tauri-plugin-deep-link. Android/macOS deliver them to the running app;
 * on Windows/Linux the single-instance plugin (deep-link feature) forwards a second launch's URL.
 */
let initialConsumed = false;
const tauriLinks: LinkAdapter = {
  initial: async () => {
    if (initialConsumed) return [];
    initialConsumed = true;
    try {
      return (await getCurrentLinks()) ?? [];
    } catch {
      return [];
    }
  },
  listen: (cb) => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    onOpenUrl(cb)
      .then((un) => (cancelled ? un() : (stop = un)))
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  },
};

function toBase64(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Exports via Rust (src-tauri/src/lib.rs export_file): Downloads folder on desktop, share sheet on Android. */
const tauriExport = (name: string, data: Uint8Array | string, mime: string) => invoke<string | null>('export_file', { name, base64: toBase64(data), mime });

const tauriLocalApi: LocalApiAdapter = {
  start: (port, token, allowLan) => invoke<string>('api_start', { port, token, allowLan }),
  stop: () => invoke('api_stop'),
  onRequest: (cb) => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    listen<{ id: number; method: string; path: string; query: string; body: string }>('focus-api-request', (e) => cb(e.payload))
      .then((un) => (cancelled ? un() : (stop = un)))
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  },
  respond: (id, status, body) => invoke('api_respond', { id, status, body }),
};
const isMobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

export function createTauriPlatform(): Platform {
  return {
    kind: 'tauri',
    persistence: new TauriPersistence(),
    files: new TauriFileStore(),
    lifecycle: tauriLifecycle,
    notifications: tauriNotifications,
    // Desktop: OS keychain. Android: Keystore-encrypted (SecureStorePlugin.kt). iOS: not built yet, session only.
    secrets: /iPhone|iPad/i.test(navigator.userAgent) ? new MemorySecretStore() : tauriSecrets,
    http: tauriHttp,
    links: tauriLinks,
    exportFile: tauriExport,
    localApi: isMobile() ? undefined : tauriLocalApi,
    backgroundSync: /Android/i.test(navigator.userAgent) ? async (enabled) => void (await invoke<boolean>('background_sync', { enabled })) : undefined,
    // The single-instance plugin guarantees one process owns the database.
    acquireLock: async () => true,
  };
}
