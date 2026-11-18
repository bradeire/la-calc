import { deriveSyncKeys, generateSyncKey, openBytes, openJson, parseSyncKey, sealBytes, sealJson, SyncDecryptError, SyncKeyError, type SyncKeys } from '@/core/sync/crypto';
import { fromLegacyVersion, hlc, KEY_SEPARATOR, parseHlc, SYNC_TABLES, SYNCED_SETTINGS, tableByName, type SyncTable } from '@/core/sync/tables';
import type { Repositories } from '@/data';
import type { Row, SqlValue } from '@/data/db/driver';
import type { FileStore, HttpAdapter, SecretStore } from '@/platform/types';
import { ValidationError } from './events';

/**
 * One row's state for sync (v2): every field with the version of its last change, and the
 * version of its deletion (if it was ever deleted). A row exists if its newest field is newer
 * than its deletion. `v`/`r` is the v1 format (whole-row version), still accepted on input.
 */
export interface SyncItem {
  t: string;
  k: string;
  f?: Record<string, [SqlValue, string]>;
  d?: string;
  v?: string;
  r?: Record<string, SqlValue> | null;
}
interface Batch {
  seq: number;
  device: string;
  data: string;
}
export interface SnapshotRef {
  id: string;
  upTo: number;
  parts: number;
}
export interface RelayUsage {
  bytes: number;
  quota: number;
  batches: number;
  licenceExpires: number | null;
}

/** A relay refusal with a machine-readable reason (quota, licence…). */
export class RelayError extends ValidationError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** Where encrypted data is stored. The relay never sees plaintext or the data key. */
export interface SyncTransport {
  push(url: string, vault: string, token: string, device: string, data: string): Promise<number>;
  pull(url: string, vault: string, token: string, after: number, limit: number): Promise<{ batches: Batch[]; more: boolean; snapshot?: SnapshotRef | null }>;
  erase(url: string, vault: string, token: string): Promise<void>;
  getSnapshotPart?(url: string, vault: string, token: string, id: string, part: number): Promise<string>;
  putSnapshotPart?(url: string, vault: string, token: string, id: string, part: number, parts: number, upTo: number, data: string): Promise<boolean>;
  blobInfo?(url: string, vault: string, token: string, id: string): Promise<{ parts: number; complete: boolean } | null>;
  getBlobPart?(url: string, vault: string, token: string, id: string, part: number): Promise<string>;
  putBlobPart?(url: string, vault: string, token: string, id: string, part: number, parts: number, data: string): Promise<void>;
  deleteBlob?(url: string, vault: string, token: string, id: string): Promise<void>;
  usage?(url: string, vault: string, token: string): Promise<RelayUsage>;
  health?(url: string): Promise<{ ok: boolean; licenceRequired: boolean }>;
}

/** The relay (tools/focus-sync-relay): a small HTTP API, hosted by you or the app's publisher. */
export class RelayTransport implements SyncTransport {
  constructor(
    private http: HttpAdapter,
    private licence: () => Promise<string | null> = async () => null,
  ) {}
  private async call(base: string, method: 'GET' | 'POST', path: string, token: string | null, body?: unknown) {
    let res;
    const licence = await this.licence();
    try {
      res = await this.http.request({
        method,
        url: base.replace(/\/+$/, '') + path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(licence ? { 'X-Focus-Licence': licence } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw new ValidationError(`Couldn’t reach the sync relay (${err instanceof Error ? err.message : typeof err === 'string' ? err : 'network error'}). Changes are kept and will sync later.`);
    }
    let data: Record<string, unknown>;
    try {
      data = res.body ? JSON.parse(res.body) : {};
    } catch {
      throw new ValidationError(`The sync relay sent an unexpected answer (${res.status}). Check the relay address.`);
    }
    const msg = typeof data.error === 'string' ? data.error : '';
    const code = typeof data.code === 'string' ? data.code : undefined;
    if (res.status === 403) throw new RelayError('The sync relay refused this sync key.', 403, code);
    if (res.status === 402) throw new RelayError(msg || 'This sync relay needs a valid licence.', 402, code ?? 'licence_required');
    if (res.status === 507) throw new RelayError('Sync storage is full. Older history is cleaned up automatically; if this persists, remove large attachments.', 507, 'quota');
    if (res.status === 429) throw new RelayError('The sync relay is busy; it will try again shortly.', 429, 'rate');
    if (res.status < 200 || res.status >= 300) throw new RelayError(`Sync relay error ${res.status}${msg ? `: ${msg}` : ''}`, res.status, code);
    return data;
  }
  async push(url: string, vault: string, token: string, device: string, data: string) {
    const r = await this.call(url, 'POST', `/v1/vaults/${vault}/batches`, token, { device, data });
    return Number(r.seq);
  }
  async erase(url: string, vault: string, token: string) {
    await this.call(url, 'POST', `/v1/vaults/${vault}/delete`, token, {});
  }
  async pull(url: string, vault: string, token: string, after: number, limit: number) {
    const r = await this.call(url, 'GET', `/v1/vaults/${vault}/batches?after=${after}&limit=${limit}`, token);
    return { batches: (r.batches as Batch[]) ?? [], more: !!r.more, snapshot: (r.snapshot as SnapshotRef | null) ?? null };
  }
  async getSnapshotPart(url: string, vault: string, token: string, id: string, part: number) {
    return String((await this.call(url, 'GET', `/v1/vaults/${vault}/snapshots/${id}/parts/${part}`, token)).data);
  }
  async putSnapshotPart(url: string, vault: string, token: string, id: string, part: number, parts: number, upTo: number, data: string) {
    return !!(await this.call(url, 'POST', `/v1/vaults/${vault}/snapshots/${id}/parts/${part}`, token, { parts, upTo, data })).complete;
  }
  async blobInfo(url: string, vault: string, token: string, id: string) {
    return ((await this.call(url, 'GET', `/v1/vaults/${vault}/blobs/${id}`, token)).blob as { parts: number; complete: boolean } | null) ?? null;
  }
  async getBlobPart(url: string, vault: string, token: string, id: string, part: number) {
    return String((await this.call(url, 'GET', `/v1/vaults/${vault}/blobs/${id}/parts/${part}`, token)).data);
  }
  async putBlobPart(url: string, vault: string, token: string, id: string, part: number, parts: number, data: string) {
    await this.call(url, 'POST', `/v1/vaults/${vault}/blobs/${id}/parts/${part}`, token, { parts, data });
  }
  async deleteBlob(url: string, vault: string, token: string, id: string) {
    await this.call(url, 'POST', `/v1/vaults/${vault}/blobs/${id}/delete`, token, {});
  }
  async usage(url: string, vault: string, token: string) {
    return (await this.call(url, 'GET', `/v1/vaults/${vault}/usage`, token)) as unknown as RelayUsage;
  }
  async health(url: string) {
    const r = await this.call(url, 'GET', '/v1/health', null);
    return { ok: !!r.ok, licenceRequired: !!r.licenceRequired };
  }
}

export interface SyncStatus {
  enabled: boolean;
  relayUrl: string | null;
  deviceId: string;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  waiting: number;
  runsTimedAutomations: boolean;
  syncing: boolean;
  usage: RelayUsage | null;
  /** Attachment files on this device not yet uploaded, and synced ones not yet downloaded. */
  filesToSend: number;
  filesToFetch: number;
}

export interface SyncOptions {
  /** Upload a snapshot (letting the relay delete older history) once this many batches build up. */
  compactAfterBatches: number;
  /** Bytes of attachment files moved per sync run, each way (the rest follows on later runs). */
  fileBudgetBytes: number;
}

/** Run a set-up step; failures say which step and keep the underlying message (native calls reject with strings). */
async function step<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
    console.error(`Sync set-up failed while ${label}`, e);
    throw new ValidationError(`Sync set-up failed while ${label}: ${detail || 'unknown error'}`);
  }
}

const SECRET = 'sync:key';
const LICENCE = 'sync:licence';
/** Characters of base64 per stored part (the relay accepts up to 1.5 million). */
const PART_CHARS = 1_400_000;
/** Keep each encrypted batch well under the relay's per-row limit. */
const MAX_BATCH_JSON = 700_000;
const PAGE = 100;

/**
 * End-to-end encrypted sync (ADR-019, ADR-020). Pull, apply (last writer wins per field), then push
 * local changes. Remote changes are applied with change capture off, so they never echo
 * back, and without domain events, so automations don't run twice.
 */
export class SyncService {
  private running: Promise<void> | null = null;
  private keys: { key: string; derived: SyncKeys } | null = null;

  private opts: SyncOptions;
  private filesToFetch = 0;

  constructor(
    private r: Repositories,
    private secrets: SecretStore,
    private transport: SyncTransport,
    private now: () => Date = () => new Date(),
    private files: FileStore | null = null,
    opts: Partial<SyncOptions> = {},
  ) {
    this.opts = { compactAfterBatches: 300, fileBudgetBytes: 25 * 1024 * 1024, ...opts };
  }

  // ---------- state ----------

  private meta(key: string): string | null {
    return this.r.db.get<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key])?.value ?? null;
  }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.r.db.run('DELETE FROM sync_meta WHERE key = ?', [key]);
    else this.r.db.run('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }
  private relayUrl(): string {
    const u = this.meta('relayUrl');
    if (!u) throw new ValidationError('No sync relay is set up');
    return u;
  }
  private control() {
    return this.r.db.get<{ enabled: number; device_id: string }>('SELECT enabled, device_id FROM sync_control WHERE id = 1')!;
  }

  status(): SyncStatus {
    const c = this.control();
    return {
      enabled: c.enabled === 1,
      relayUrl: this.meta('relayUrl'),
      deviceId: c.device_id,
      lastSyncAt: this.meta('lastSyncAt'),
      lastError: this.meta('lastError'),
      pending: this.r.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT DISTINCT tbl, row_key FROM sync_changes)')!.n,
      waiting: this.waitingItems().length,
      runsTimedAutomations: this.runsTimedAutomations(),
      syncing: this.running !== null,
      usage: this.meta('usage') ? (JSON.parse(this.meta('usage')!) as RelayUsage) : null,
      filesToSend: this.r.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM attachments a WHERE a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_meta m WHERE m.key = 'blob:' || a.storage_key)",
      )!.n,
      filesToFetch: this.filesToFetch,
    };
  }

  /** Time-based automations run on one device only, so they don't fire twice. */
  runsTimedAutomations(): boolean {
    return this.control().enabled !== 1 || this.meta('timedAutomations') !== '0';
  }
  setRunsTimedAutomations(on: boolean) {
    this.setMeta('timedAutomations', on ? '1' : '0');
  }

  /** Adjust compaction and file limits (tests, or a hosted relay's own policy). */
  setOptions(opts: Partial<SyncOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  async getLicence(): Promise<string | null> {
    return this.secrets.get(LICENCE);
  }
  async setLicence(licence: string | null): Promise<void> {
    if (licence && licence.trim()) await this.secrets.set(LICENCE, licence.trim());
    else await this.secrets.delete(LICENCE);
  }
  /** Whether a relay needs a licence to set up sync (hosted relays may). */
  async relayNeedsLicence(relayUrl: string): Promise<boolean> {
    if (!this.transport.health) return false;
    try {
      return (await this.transport.health(relayUrl.trim().replace(/\/+$/, ''))).licenceRequired;
    } catch {
      return false;
    }
  }

  async getKey(): Promise<string | null> {
    return this.secrets.get(SECRET);
  }

  private async derived(): Promise<SyncKeys> {
    const key = await this.secrets.get(SECRET);
    if (!key) throw new ValidationError('Enter your sync key on this device to continue syncing.');
    if (this.keys?.key !== key) this.keys = { key, derived: await deriveSyncKeys(key) };
    return this.keys.derived;
  }

  // ---------- set up ----------

  /**
   * Turn sync on. Without a key, a new vault is created (first device). With a key, this
   * device joins: its existing data is merged with what the other devices have.
   */
  async enable(opts: { relayUrl: string; key?: string; licence?: string }): Promise<{ key: string }> {
    if (opts.licence !== undefined) await this.setLicence(opts.licence);
    const url = opts.relayUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) throw new ValidationError('The relay address must start with https://');
    const joining = !!opts.key;
    let key: string;
    try {
      key = opts.key ? opts.key.trim() : generateSyncKey();
      parseSyncKey(key);
    } catch (e) {
      throw new ValidationError(e instanceof SyncKeyError ? e.message : 'That isn’t a valid sync key');
    }
    // Check the relay and the key before changing anything.
    const derived = await step('preparing the encryption keys', () => deriveSyncKeys(key));
    const first = await step('contacting the relay', () => this.transport.pull(url, derived.vaultId, derived.token, 0, 1));
    if (joining && first.batches.length === 0 && !first.snapshot) throw new ValidationError('Nothing has been synced with this key yet. Check the key, or set up sync on the other device first.');
    // Check the key opens what's there (a batch, or the snapshot older history was compacted into).
    const sample = first.batches[0]?.data ?? (first.snapshot && this.transport.getSnapshotPart ? await this.transport.getSnapshotPart(url, derived.vaultId, derived.token, first.snapshot.id, 0) : null);
    if (joining && sample) await openJson(derived, sample).catch(() => {
      throw new ValidationError('This key doesn’t match the data on the relay.');
    });
    // A new vault always gets a first (empty) batch, so other devices can join even if this one has no data yet.
    if (!joining) {
      const hello = await step('encrypting the first upload', () => sealJson(derived, []));
      await step('creating your sync space on the relay', () => this.transport.push(url, derived.vaultId, derived.token, this.control().device_id, hello));
    }
    await step('saving the sync key in secure storage', () => this.secrets.set(SECRET, key));
    this.keys = { key, derived };
    await step('preparing this device’s data', () => this.r.db.transaction(() => {
      this.setMeta('relayUrl', url);
      this.setMeta('cursor', '0');
      this.setMeta('lastError', null);
      this.setMeta('timedAutomations', joining ? '0' : '1');
      this.r.db.run('UPDATE sync_control SET enabled = 1 WHERE id = 1');
      this.bootstrap();
    }));
    await step('running the first sync', () => this.syncNow());
    return { key };
  }

  /** Queue every existing row once; fields get versions from the row's own timestamps, so older rows don't win. */
  private bootstrap() {
    const device = this.control().device_id;
    for (const t of SYNC_TABLES) {
      const cols = new Set(this.r.db.all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => c.name));
      const ts = ['updated_at', 'created_at', 'started_at'].filter((c) => cols.has(c));
      const when = ts.length ? `COALESCE(${ts.join(', ')}, '1970-01-01T00:00:00.000Z')` : "'1970-01-01T00:00:00.000Z'";
      const ms = `CAST(ROUND((julianday(${when}) - 2440587.5) * 86400000) AS INTEGER)`;
      const key = t.key.join(' || char(31) || ');
      const where = t.name === 'settings' ? `WHERE key IN (${SYNCED_SETTINGS.map((k) => `'${k}'`).join(', ')})` : '';
      const values = `(VALUES ${t.columns.filter((c) => cols.has(c)).map((c) => `('${c}')`).join(', ')})`;
      this.r.db.run(`INSERT INTO sync_changes (tbl, row_key) SELECT '${t.name}', ${key} FROM ${t.name} ${where}`);
      this.r.db.run(
        `INSERT OR IGNORE INTO sync_fields (tbl, row_key, col, version) SELECT '${t.name}', ${key}, c.column1, printf('%013d-%05d-%s', ${ms}, 0, ?) FROM ${t.name}, ${values} c ${where}`,
        [device],
      );
    }
  }

  async disable(): Promise<void> {
    this.r.db.transaction(() => {
      this.r.db.run('UPDATE sync_control SET enabled = 0 WHERE id = 1');
      this.r.db.run('DELETE FROM sync_changes');
      this.r.db.run('DELETE FROM sync_fields');
      this.r.db.run('DELETE FROM sync_tombstones');
      this.r.db.run('DELETE FROM sync_meta');
    });
    this.keys = null;
    this.filesToFetch = 0;
    await this.secrets.delete(SECRET);
  }

  /**
   * Erase everything this vault stored on the relay, then turn sync off here. Other devices
   * keep their data but stop syncing (their next sync reports the vault as empty/new).
   */
  async eraseRelayData(): Promise<void> {
    const keys = await this.derived();
    await this.transport.erase(this.relayUrl(), keys.vaultId, keys.token);
    await this.disable();
  }

  /** Link and key for adding another device. */
  async joinDetails(): Promise<{ relay: string; key: string } | null> {
    const key = await this.secrets.get(SECRET);
    const relay = this.meta('relayUrl');
    return key && relay ? { relay, key } : null;
  }

  /** Re-enter the key on a device whose secure storage forgot it (e.g. the browser). */
  async setKey(key: string): Promise<void> {
    try {
      parseSyncKey(key.trim());
    } catch (e) {
      throw new ValidationError(e instanceof SyncKeyError ? e.message : 'That isn’t a valid sync key');
    }
    await this.secrets.set(SECRET, key.trim());
    await this.syncNow();
  }

  // ---------- sync ----------

  /** Pull then push. Concurrent calls share one run. Errors are recorded and re-thrown. */
  syncNow(): Promise<void> {
    if (this.control().enabled !== 1) return Promise.resolve();
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run() {
    try {
      const keys = await step('reading the sync key', () => this.derived());
      await step('downloading changes', () => this.pull(keys));
      await step('uploading changes', () => this.push(keys));
      // Advance past our own batches, so a snapshot can cover them.
      await step('downloading changes', () => this.pull(keys));
      await step('syncing attachment files', () => this.syncFiles(keys));
      await step('tidying up sync history', () => this.housekeeping(keys));
      this.setMeta('lastSyncAt', this.now().toISOString());
      this.setMeta('lastError', null);
    } catch (err) {
      this.setMeta('lastError', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async pull(keys: SyncKeys) {
    const me = this.control().device_id;
    for (let guard = 0; guard < 10_000; guard++) {
      const after = Number(this.meta('cursor') ?? '0');
      const page = await this.transport.pull(this.relayUrl(), keys.vaultId, keys.token, after, PAGE);
      if (page.snapshot && after < page.snapshot.upTo) {
        // Older history was compacted into a snapshot: load it, then carry on after it.
        await this.loadSnapshot(keys, page.snapshot);
        continue;
      }
      if (!page.batches.length) break;
      const items: SyncItem[] = [];
      for (const b of page.batches) {
        if (b.device === me) continue;
        try {
          items.push(...(await openJson<SyncItem[]>(keys, b.data)));
        } catch (e) {
          if (e instanceof SyncDecryptError) throw new ValidationError(e.message);
          throw e;
        }
      }
      this.apply([...this.waitingItems(), ...items]);
      this.setMeta('cursor', String(page.batches[page.batches.length - 1]!.seq));
      if (!page.more) break;
    }
    // Rows that waited for a parent may now fit.
    if (this.waitingItems().length) this.apply(this.waitingItems());
  }

  private async push(keys: SyncKeys) {
    const me = this.control().device_id;
    for (let guard = 0; guard < 1000; guard++) {
      const changes = this.r.db.all<{ tbl: string; row_key: string; seq: number }>(
        'SELECT tbl, row_key, MAX(seq) AS seq FROM sync_changes GROUP BY tbl, row_key ORDER BY seq LIMIT 5000',
      );
      if (!changes.length) return;
      const maxSeq = Math.max(...changes.map((c) => c.seq));
      const items = changes.map((c) => this.readItem(c.tbl, c.row_key)).filter((x): x is SyncItem => !!x);
      let chunk: SyncItem[] = [];
      let size = 0;
      const flush = async () => {
        if (!chunk.length) return;
        await this.transport.push(this.relayUrl(), keys.vaultId, keys.token, me, await sealJson(keys, chunk));
        chunk = [];
        size = 0;
      };
      for (const it of items) {
        const n = JSON.stringify(it).length;
        if (size + n > MAX_BATCH_JSON) await flush();
        chunk.push(it);
        size += n;
      }
      await flush();
      this.r.db.run('DELETE FROM sync_changes WHERE seq <= ?', [maxSeq]);
    }
  }

  // ---------- snapshots (compaction) ----------

  private async loadSnapshot(keys: SyncKeys, snap: SnapshotRef) {
    if (!this.transport.getSnapshotPart) throw new ValidationError('This relay needs a newer version of Focus');
    const items: SyncItem[] = [];
    for (let i = 0; i < snap.parts; i++) {
      const data = await this.transport.getSnapshotPart(this.relayUrl(), keys.vaultId, keys.token, snap.id, i);
      items.push(...(await openJson<SyncItem[]>(keys, data)));
    }
    this.apply([...this.waitingItems(), ...items]);
    this.setMeta('cursor', String(snap.upTo));
  }

  /** Every synced row's current state (including deletions), for a snapshot. */
  private allItems(): SyncItem[] {
    const keys = this.r.db.all<{ tbl: string; row_key: string }>('SELECT DISTINCT tbl, row_key FROM sync_fields UNION SELECT tbl, row_key FROM sync_tombstones');
    return keys.map((k) => this.readItem(k.tbl, k.row_key)).filter((x): x is SyncItem => !!x);
  }

  /**
   * Upload a snapshot of everything up to the current cursor; once complete, the relay deletes
   * the batches it covers. Only when nothing is waiting or unsent, so the snapshot is complete.
   */
  async compact(keys?: SyncKeys): Promise<boolean> {
    if (!this.transport.putSnapshotPart) return false;
    const k = keys ?? (await this.derived());
    const st = this.status();
    if (st.pending > 0 || st.waiting > 0) return false;
    const upTo = Number(this.meta('cursor') ?? '0');
    if (upTo <= 0) return false;
    const chunks: SyncItem[][] = [[]];
    let size = 0;
    for (const it of this.allItems()) {
      const n = JSON.stringify(it).length;
      if (size + n > MAX_BATCH_JSON && chunks[chunks.length - 1]!.length) {
        chunks.push([]);
        size = 0;
      }
      chunks[chunks.length - 1]!.push(it);
      size += n;
    }
    const id = `snap-${this.now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let complete = false;
    for (let i = 0; i < chunks.length; i++) {
      complete = await this.transport.putSnapshotPart(this.relayUrl(), k.vaultId, k.token, id, i, chunks.length, upTo, await sealJson(k, chunks[i]));
    }
    return complete;
  }

  private async housekeeping(keys: SyncKeys) {
    if (!this.transport.usage) return;
    let usage = await this.transport.usage(this.relayUrl(), keys.vaultId, keys.token);
    if (usage.batches >= this.opts.compactAfterBatches && (await this.compact(keys))) {
      usage = await this.transport.usage(this.relayUrl(), keys.vaultId, keys.token);
    }
    this.setMeta('usage', JSON.stringify(usage));
  }

  // ---------- attachment files ----------

  private async blobId(keys: SyncKeys, storageKey: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${keys.vaultId}:${storageKey}`));
    return [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Upload this device's files, download missing ones, and remove files of purged attachments. */
  private async syncFiles(keys: SyncKeys) {
    const t = this.transport;
    if (!this.files || !t.putBlobPart || !t.blobInfo || !t.getBlobPart || !t.deleteBlob) return;
    const url = this.relayUrl();
    const local = new Set(await this.files.keys());
    const rows = this.r.db.all<{ storage_key: string; mime_type: string; size_bytes: number; deleted_at: string | null }>(
      'SELECT storage_key, mime_type, size_bytes, deleted_at FROM attachments',
    );
    const uploaded = new Set(this.r.db.all<{ key: string }>("SELECT key FROM sync_meta WHERE key LIKE 'blob:%'").map((x) => x.key.slice(5)));

    let budget = this.opts.fileBudgetBytes;
    for (const a of rows) {
      if (a.deleted_at || uploaded.has(a.storage_key) || !local.has(a.storage_key)) continue;
      if (budget <= 0) break;
      const blob = await this.files.get(a.storage_key);
      if (!blob) continue;
      const id = await this.blobId(keys, a.storage_key);
      const sealed = await sealBytes(keys, id, new Uint8Array(await blob.arrayBuffer()));
      const parts = Math.max(1, Math.ceil(sealed.length / PART_CHARS));
      for (let i = 0; i < parts; i++) await t.putBlobPart(url, keys.vaultId, keys.token, id, i, parts, sealed.slice(i * PART_CHARS, (i + 1) * PART_CHARS));
      this.setMeta(`blob:${a.storage_key}`, 'up');
      budget -= a.size_bytes;
    }

    budget = this.opts.fileBudgetBytes;
    let missing = 0;
    for (const a of rows) {
      if (a.deleted_at || local.has(a.storage_key)) continue;
      missing++;
      if (budget <= 0) continue;
      const id = await this.blobId(keys, a.storage_key);
      const info = await t.blobInfo(url, keys.vaultId, keys.token, id);
      if (!info?.complete) continue;
      let data = '';
      for (let i = 0; i < info.parts; i++) data += await t.getBlobPart(url, keys.vaultId, keys.token, id, i);
      const bytes = await openBytes(keys, id, data);
      await this.files.put(a.storage_key, new Blob([bytes as BlobPart], { type: a.mime_type }));
      this.setMeta(`blob:${a.storage_key}`, 'up');
      budget -= a.size_bytes;
      missing--;
    }
    this.filesToFetch = missing;

    // Attachments removed for good (purged from Trash): remove their files from the relay too.
    const keysInDb = new Set(rows.map((a) => a.storage_key));
    for (const key of uploaded) {
      if (keysInDb.has(key)) continue;
      await t.deleteBlob(url, keys.vaultId, keys.token, await this.blobId(keys, key));
      this.setMeta(`blob:${key}`, null);
    }
  }

  private where(t: SyncTable, key: string): { sql: string; params: string[] } {
    const parts = key.split(KEY_SEPARATOR);
    return { sql: t.key.map((k) => `${k} = ?`).join(' AND '), params: parts };
  }

  private readItem(tbl: string, key: string): SyncItem | null {
    const t = tableByName.get(tbl);
    if (!t) return null;
    const w = this.where(t, key);
    const row = this.r.db.get<Row>(`SELECT * FROM ${tbl} WHERE ${w.sql}`, w.params);
    const d = this.r.db.get<{ version: string }>('SELECT version FROM sync_tombstones WHERE tbl = ? AND row_key = ?', [tbl, key])?.version;
    if (!row) return d ? { t: tbl, k: key, d } : null;
    const versions = new Map(this.r.db.all<{ col: string; version: string }>('SELECT col, version FROM sync_fields WHERE tbl = ? AND row_key = ?', [tbl, key]).map((x) => [x.col, x.version]));
    const floor = hlc(0, 0, this.control().device_id);
    const f: Record<string, [SqlValue, string]> = {};
    for (const [col, value] of Object.entries(row)) f[col] = [value as SqlValue, versions.get(col) ?? floor];
    return d ? { t: tbl, k: key, f, d } : { t: tbl, k: key, f };
  }

  // ---------- apply ----------

  private waitingItems(): SyncItem[] {
    const raw = this.meta('waiting');
    return raw ? (JSON.parse(raw) as SyncItem[]) : [];
  }

  /** v1 items (whole-row version) as v2 (every field carries that version). */
  private normalise(it: SyncItem): SyncItem {
    if (!it.v) return it;
    const v = fromLegacyVersion(it.v);
    if (!it.r) return { t: it.t, k: it.k, d: v };
    return { t: it.t, k: it.k, f: Object.fromEntries(Object.entries(it.r).map(([c, x]) => [c, [x, v] as [SqlValue, string]])) };
  }

  /** Apply remote rows field by field (newest version wins). Rows whose parent hasn't arrived wait for the next sync. */
  apply(items: SyncItem[]) {
    const order = new Map(SYNC_TABLES.map((t, i) => [t.name, i]));
    const sorted = items
      .filter((i) => tableByName.has(i.t))
      .map((i) => this.normalise(i))
      .sort((a, b) => order.get(a.t)! - order.get(b.t)!);
    const waiting: SyncItem[] = [];
    this.r.db.run('UPDATE sync_control SET applying = 1 WHERE id = 1');
    try {
      try {
        this.r.db.transaction(() => {
          this.r.db.exec('PRAGMA defer_foreign_keys = ON');
          for (const it of sorted) this.applyOne(it);
          if (this.r.db.all('PRAGMA foreign_key_check').length) throw new Error('foreign keys');
        });
      } catch {
        // One by one: everything that fits is applied; the rest waits.
        for (const it of sorted) {
          try {
            this.r.db.transaction(() => this.applyOne(it));
          } catch {
            waiting.push(it);
          }
        }
      }
      this.observe(sorted);
    } finally {
      this.r.db.run('UPDATE sync_control SET applying = 0 WHERE id = 1');
    }
    this.setMeta('waiting', waiting.length ? JSON.stringify(waiting.slice(-2000)) : null);
  }

  /** Hybrid logical clock: move this device's clock past every version it has seen. */
  private observe(items: SyncItem[]) {
    let best: { ms: number; counter: number } | null = null;
    for (const it of items) {
      for (const v of [it.d, ...Object.values(it.f ?? {}).map((x) => x[1])]) {
        const h = v ? parseHlc(v) : null;
        if (h && (!best || h.ms > best.ms || (h.ms === best.ms && h.counter > best.counter))) best = h;
      }
    }
    if (!best) return;
    const c = this.r.db.get<{ hlc_ms: number; hlc_counter: number }>('SELECT hlc_ms, hlc_counter FROM sync_control WHERE id = 1')!;
    if (best.ms > c.hlc_ms || (best.ms === c.hlc_ms && best.counter > c.hlc_counter)) {
      this.r.db.run('UPDATE sync_control SET hlc_ms = ?, hlc_counter = ? WHERE id = 1', [best.ms, best.counter]);
    }
  }

  private applyOne(it: SyncItem) {
    const t = tableByName.get(it.t)!;
    if (it.t === 'settings' && !(SYNCED_SETTINGS as readonly string[]).includes(it.k)) return;
    const w = this.where(t, it.k);
    const local = new Map(
      this.r.db.all<{ col: string; version: string }>('SELECT col, version FROM sync_fields WHERE tbl = ? AND row_key = ?', [it.t, it.k]).map((x) => [x.col, x.version]),
    );
    const localTomb = this.r.db.get<{ version: string }>('SELECT version FROM sync_tombstones WHERE tbl = ? AND row_key = ?', [it.t, it.k])?.version ?? '';
    const tomb = (it.d ?? '') > localTomb ? it.d! : localTomb;
    const incoming = it.f ?? {};
    const winners = Object.keys(incoming).filter((c) => incoming[c]![1] > (local.get(c) ?? ''));
    let newest = '';
    for (const c of new Set([...local.keys(), ...Object.keys(incoming)])) {
      const v = [local.get(c) ?? '', incoming[c]?.[1] ?? ''].reduce((a, b) => (a > b ? a : b));
      if (v > newest) newest = v;
    }
    const exists = newest !== '' && newest > tomb;
    const rowExists = !!this.r.db.get(`SELECT 1 FROM ${it.t} WHERE ${w.sql}`, w.params);
    const tableCols = new Set(this.r.db.all<{ name: string }>(`PRAGMA table_info(${it.t})`).map((c) => c.name));

    if (!exists) {
      if (rowExists) this.r.db.run(`DELETE FROM ${it.t} WHERE ${w.sql}`, w.params);
    } else if (rowExists) {
      const set = winners.filter((c) => tableCols.has(c) && !t.key.includes(c));
      if (set.length) {
        const current = this.r.db.get<Row>(`SELECT * FROM ${it.t} WHERE ${w.sql}`, w.params)!;
        const row: Record<string, SqlValue> = { ...(current as Record<string, SqlValue>) };
        for (const c of set) row[c] = incoming[c]![0];
        if (!this.resolveUnique(it.t, row)) return;
        this.r.db.run(`UPDATE ${it.t} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE ${w.sql}`, [...set.map((c) => row[c] ?? null), ...w.params]);
      }
    } else {
      const row: Record<string, SqlValue> = {};
      for (const [c, [value]] of Object.entries(incoming)) if (tableCols.has(c)) row[c] = value;
      if (!this.resolveUnique(it.t, row)) return;
      const cols = Object.keys(row);
      if (!t.key.every((k) => k in row)) return;
      this.r.db.run(`INSERT INTO ${it.t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
    }
    for (const c of winners) {
      this.r.db.run('INSERT INTO sync_fields (tbl, row_key, col, version) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, row_key, col) DO UPDATE SET version = excluded.version', [
        it.t,
        it.k,
        c,
        incoming[c]![1],
      ]);
    }
    if (tomb && tomb !== localTomb) {
      this.r.db.run('INSERT INTO sync_tombstones (tbl, row_key, version) VALUES (?, ?, ?) ON CONFLICT(tbl, row_key) DO UPDATE SET version = excluded.version', [it.t, it.k, tomb]);
    }
  }

  /**
   * Secondary unique rules, settled the same way on every device:
   *  - two labels with the same name: the one with the larger id is renamed "name-xxxx";
   *  - two repeat rules for one task: the later-updated (then larger id) wins;
   *  - an automation run already recorded for the same event: keep ours.
   * Returns false when the incoming row should be skipped.
   */
  private resolveUnique(table: string, row: Record<string, SqlValue>): boolean {
    if (table === 'labels' && row.deleted_at == null) {
      const clash = this.r.db.get<{ id: string; name: string }>('SELECT id, name FROM labels WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id <> ?', [
        String(row.name),
        String(row.id),
      ]);
      if (clash) {
        const rename = (name: string, id: string) => `${name.slice(0, 55)}-${id.slice(0, 4)}`;
        if (String(row.id) > clash.id) row.name = rename(String(row.name), String(row.id));
        else this.r.db.run('UPDATE labels SET name = ? WHERE id = ?', [rename(clash.name, clash.id), clash.id]);
      }
    }
    if (table === 'recurrence_rules') {
      const other = this.r.db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM recurrence_rules WHERE task_id = ? AND id <> ?', [String(row.task_id), String(row.id)]);
      if (other) {
        const incomingWins = String(row.updated_at) > other.updated_at || (String(row.updated_at) === other.updated_at && String(row.id) > other.id);
        if (!incomingWins) return false;
        this.r.db.run('DELETE FROM recurrence_rules WHERE id = ?', [other.id]);
      }
    }
    if (table === 'automation_runs') {
      const dup = this.r.db.get('SELECT 1 FROM automation_runs WHERE automation_id = ? AND event_key = ? AND id <> ?', [String(row.automation_id), String(row.event_key), String(row.id)]);
      if (dup) return false;
    }
    return true;
  }
}

export { generateSyncKey };
