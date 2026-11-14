import type { FileStore, PersistenceAdapter, Platform } from './types';

/** In-memory platform for automated tests. Never used in production screens. */
export class MemoryPersistence implements PersistenceAdapter {
  readonly name = 'memory';
  current: Uint8Array | null = null;
  previous: Uint8Array | null = null;
  snapshots = new Map<string, Uint8Array>();
  saves = 0;
  async load() {
    return this.current;
  }
  async loadPrevious() {
    return this.previous;
  }
  async save(bytes: Uint8Array) {
    this.previous = this.current;
    this.current = bytes;
    this.saves++;
  }
  async saveSnapshot(name: string, bytes: Uint8Array) {
    this.snapshots.set(name, bytes);
  }
  async requestDurable() {
    return true;
  }
}

export class MemoryFileStore implements FileStore {
  files = new Map<string, Blob>();
  async put(key: string, data: Blob) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async keys() {
    return [...this.files.keys()];
  }
}

export function createMemoryPlatform(): Platform & { persistence: MemoryPersistence; files: MemoryFileStore } {
  return {
    kind: 'memory',
    persistence: new MemoryPersistence(),
    files: new MemoryFileStore(),
    lifecycle: { onPause: () => () => {} },
    acquireLock: async () => true,
  };
}
