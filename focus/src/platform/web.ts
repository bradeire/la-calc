import type { FileStore, LifecycleAdapter, PersistenceAdapter, Platform } from './types';

const DB_NAME = 'focus';
const DB_VERSION = 1;
const STORE_DB = 'database';
const STORE_FILES = 'files';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DB)) db.createObjectStore(STORE_DB);
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open browser storage'));
    req.onblocked = () => reject(new Error('Browser storage is blocked by another open Focus window'));
  });
}

let idbPromise: Promise<IDBDatabase> | null = null;
const idb = () => (idbPromise ??= openIdb());

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return idb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode, { durability: 'strict' } as IDBTransactionOptions);
        const s = t.objectStore(store);
        const req = fn(s);
        let result: T | undefined;
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('Storage transaction failed'));
        t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted (storage may be full)'));
      }),
  );
}

const asBytes = (v: unknown): Uint8Array | null => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null);

export class IndexedDbPersistence implements PersistenceAdapter {
  readonly name = 'IndexedDB';

  async load() {
    return asBytes(await tx(STORE_DB, 'readonly', (s) => s.get('current')));
  }

  async loadPrevious() {
    return asBytes(await tx(STORE_DB, 'readonly', (s) => s.get('previous')));
  }

  /** Rotate current → previous and write the new image in one IndexedDB transaction. */
  async save(bytes: Uint8Array) {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_DB, 'readwrite', { durability: 'strict' } as IDBTransactionOptions);
      const s = t.objectStore(STORE_DB);
      const getReq = s.get('current');
      getReq.onsuccess = () => {
        if (getReq.result) s.put(getReq.result, 'previous');
        s.put(bytes, 'current');
        s.put(new Date().toISOString(), 'savedAt');
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('Saving failed'));
      t.onabort = () => reject(t.error ?? new Error('Saving was aborted — device storage may be full'));
    });
  }

  async saveSnapshot(name: string, bytes: Uint8Array) {
    await tx(STORE_DB, 'readwrite', (s) => s.put(bytes, `snapshot:${name}`));
  }

  async requestDurable() {
    try {
      if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch (err) {
      console.warn('Persistent storage request failed', err);
    }
    return false;
  }
}

export class IndexedDbFileStore implements FileStore {
  async put(key: string, data: Blob) {
    // Store as ArrayBuffer: Blob support in IndexedDB is unreliable in some Android webviews.
    const buf = await data.arrayBuffer();
    await tx(STORE_FILES, 'readwrite', (s) => s.put({ buf, type: data.type }, key));
  }
  async get(key: string) {
    const v = (await tx<{ buf: ArrayBuffer; type: string }>(STORE_FILES, 'readonly', (s) => s.get(key))) ?? null;
    return v ? new Blob([v.buf], { type: v.type }) : null;
  }
  async delete(key: string) {
    await tx(STORE_FILES, 'readwrite', (s) => s.delete(key));
  }
  async keys() {
    return ((await tx<IDBValidKey[]>(STORE_FILES, 'readonly', (s) => s.getAllKeys())) ?? []).map(String);
  }
}

export const webLifecycle: LifecycleAdapter = {
  onPause(cb) {
    const run = () => void cb();
    const vis = () => document.visibilityState === 'hidden' && run();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', run);
    window.addEventListener('beforeunload', run);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', run);
      window.removeEventListener('beforeunload', run);
    };
  },
};

/** Hold a Web Lock for the life of the page so a second tab cannot overwrite our data. */
async function acquireLock(): Promise<boolean> {
  if (!('locks' in navigator)) return true; // Older browsers: single-tab use is documented.
  return new Promise<boolean>((resolve) => {
    navigator.locks
      .request('focus-database', { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<void>(() => {}); // never released while the page lives
      })
      .catch((err: unknown) => {
        console.error('Lock request failed', err);
        resolve(true);
      });
  });
}

export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    persistence: new IndexedDbPersistence(),
    files: new IndexedDbFileStore(),
    lifecycle: webLifecycle,
    acquireLock,
  };
}

/** True inside the Tauri native shell. */
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
