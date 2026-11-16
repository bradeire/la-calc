import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { FileStore, HttpAdapter, LifecycleAdapter, NotificationAdapter, PersistenceAdapter, Platform, SecretStore } from './types';

/**
 * Native platform (Tauri 2). The SQLite image is a real file in the app-data
 * directory, written atomically by Rust (src-tauri/src/storage.rs). Bytes cross
 * the IPC bridge as raw binary bodies, not JSON arrays.
 */
const asBytes = (buf: ArrayBuffer) => (buf.byteLength ? new Uint8Array(buf) : null);

class TauriPersistence implements PersistenceAdapter {
  readonly name = 'SQLite file';
  async load() {
    return asBytes(await invoke<ArrayBuffer>('db_load'));
  }
  async loadPrevious() {
    return asBytes(await invoke<ArrayBuffer>('db_load_previous'));
  }
  async save(bytes: Uint8Array) {
    await invoke('db_save', bytes);
  }
  async saveSnapshot(name: string, bytes: Uint8Array) {
    await invoke('db_snapshot', bytes, { headers: { 'x-focus-name': name } });
  }
  async requestDurable() {
    return true; // App-data files are not subject to browser eviction.
  }
}

class TauriFileStore implements FileStore {
  async put(key: string, data: Blob) {
    await invoke('file_put', new Uint8Array(await data.arrayBuffer()), { headers: { 'x-focus-key': key } });
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

export function createTauriPlatform(): Platform {
  return {
    kind: 'tauri',
    persistence: new TauriPersistence(),
    files: new TauriFileStore(),
    lifecycle: tauriLifecycle,
    notifications: tauriNotifications,
    secrets: tauriSecrets,
    http: tauriHttp,
    // The single-instance plugin guarantees one process owns the database.
    acquireLock: async () => true,
  };
}
