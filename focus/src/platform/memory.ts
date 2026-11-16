import type { FileStore, HttpAdapter, HttpRequest, HttpResponse, PersistenceAdapter, Platform } from './types';
import { MemorySecretStore } from './web';

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

/** Test HTTP adapter: records requests and replies via a handler set by the test. */
export class FakeHttp implements HttpAdapter {
  requests: HttpRequest[] = [];
  handler: (r: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => ({ status: 200, body: '{}' });
  async request(r: HttpRequest) {
    this.requests.push(r);
    return this.handler(r);
  }
}

export function createMemoryPlatform(): Platform & { persistence: MemoryPersistence; files: MemoryFileStore; http: FakeHttp } {
  return {
    kind: 'memory',
    persistence: new MemoryPersistence(),
    files: new MemoryFileStore(),
    lifecycle: { onPause: () => () => {} },
    notifications: {
      permission: async () => 'unsupported',
      requestPermission: async () => 'unsupported',
      show: async () => false,
      onAction: () => () => {},
    },
    secrets: new MemorySecretStore(),
    http: new FakeHttp(),
    acquireLock: async () => true,
  };
}
