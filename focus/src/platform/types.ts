/** Platform abstraction (ARCHITECTURE.md). Business logic depends only on these interfaces. */

export interface PersistenceAdapter {
  readonly name: string;
  /** Latest saved database image, or null on first run. */
  load(): Promise<Uint8Array | null>;
  /** Previous good image (rotated on every save) for recovery. */
  loadPrevious(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  /**
   * Synchronous last-chance save while the page unloads with changes still unsaved (browser:
   * tab-scoped sessionStorage, preferred by the next load). Optional.
   */
  saveSync?(bytes: Uint8Array): boolean;
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

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface SystemNotification {
  /** Reminder id (used as the notification tag, so repeats replace rather than stack). */
  id: string;
  title: string;
  body: string;
}

/** System notifications. In-app reminders work without this; it adds OS-level alerts. */
export interface NotificationAdapter {
  permission(): Promise<NotificationPermissionState>;
  requestPermission(): Promise<NotificationPermissionState>;
  /** Returns false if it could not be shown (no permission, unsupported). */
  show(n: SystemNotification): Promise<boolean>;
  /** Actions chosen on a notification (Complete / Snooze), where the platform supports them. */
  onAction(cb: (a: { reminderId: string; action: 'complete' | 'snooze' | 'open' }) => void): () => void;
}

/** Secrets never go in SQLite (spec 6.5). Native: OS keychain. Browser: memory for this session only. */
export interface SecretStore {
  /** Whether secrets survive an app restart on this platform. */
  readonly persistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  body: string;
}

/** Outbound HTTP for user-configured integrations only (AI providers, webhooks). */
export interface HttpAdapter {
  request(r: HttpRequest): Promise<HttpResponse>;
}

/** Incoming tap-to-add links (focus://add?text=…); see src/core/links.ts. */
export interface LinkAdapter {
  /** Links that launched the app (cold start). Each is returned once. */
  initial(): Promise<string[]>;
  /** Links opened while the app is running. */
  listen(cb: (urls: string[]) => void): () => void;
}

/** Local API server (desktop app only; spec 6.7). */
export interface LocalApiAdapter {
  /** Returns the address it listens on. */
  start(port: number, token: string, allowLan: boolean): Promise<string>;
  stop(): Promise<void>;
  onRequest(cb: (r: { id: number; method: string; path: string; query: string; body: string }) => void): () => void;
  respond(id: number, status: number, body: string): Promise<void>;
}

export interface Platform {
  kind: 'web' | 'tauri' | 'memory';
  persistence: PersistenceAdapter;
  files: FileStore;
  lifecycle: LifecycleAdapter;
  notifications: NotificationAdapter;
  secrets: SecretStore;
  http: HttpAdapter;
  links: LinkAdapter;
  /**
   * Offer an exported file to the user. Browser: download. Desktop app: saved to the
   * Downloads folder (returns the path). Android: system share sheet (returns null).
   */
  exportFile(name: string, data: Uint8Array | string, mime: string): Promise<string | null>;
  /** Android: schedule or cancel periodic background sync while the app is closed. */
  backgroundSync?: (enabled: boolean) => Promise<void>;
  /** Present only where Focus can run a local API (the desktop app). */
  localApi?: LocalApiAdapter;
  /** Acquire exclusive ownership of the database; false if another window has it. */
  acquireLock(): Promise<boolean>;
}
