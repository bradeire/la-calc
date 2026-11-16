/** Platform abstraction (ARCHITECTURE.md). Business logic depends only on these interfaces. */

export interface PersistenceAdapter {
  readonly name: string;
  /** Latest saved database image, or null on first run. */
  load(): Promise<Uint8Array | null>;
  /** Previous good image (rotated on every save) for recovery. */
  loadPrevious(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  /** Keep a named copy, e.g. before a migration or an import. */
  saveSnapshot(name: string, bytes: Uint8Array): Promise<void>;
  /** Ask the platform not to evict our storage (browser). Returns whether persistence is granted. */
  requestDurable(): Promise<boolean>;
}

export interface FileStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface LifecycleAdapter {
  /** App is being hidden/backgrounded — flush now. */
  onPause(cb: () => void | Promise<void>): () => void;
}

export interface Platform {
  kind: 'web' | 'tauri' | 'memory';
  persistence: PersistenceAdapter;
  files: FileStore;
  lifecycle: LifecycleAdapter;
  /** Acquire exclusive ownership of the database; false if another window has it. */
  acquireLock(): Promise<boolean>;
}
