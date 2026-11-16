import { deriveSyncKeys, generateSyncKey, openJson, parseSyncKey, sealJson, SyncDecryptError, SyncKeyError, type SyncKeys } from '@/core/sync/crypto';
import { fromLegacyVersion, hlc, KEY_SEPARATOR, parseHlc, SYNC_TABLES, SYNCED_SETTINGS, tableByName, type SyncTable } from '@/core/sync/tables';
import type { Repositories } from '@/data';
import type { Row, SqlValue } from '@/data/db/driver';
import type { HttpAdapter, SecretStore } from '@/platform/types';
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

/** Where encrypted batches are stored. The relay never sees plaintext or the data key. */
export interface SyncTransport {
  push(url: string, vault: string, token: string, device: string, data: string): Promise<number>;
  pull(url: string, vault: string, token: string, after: number, limit: number): Promise<{ batches: Batch[]; more: boolean }>;
  erase(url: string, vault: string, token: string): Promise<void>;
}

/** The relay (tools/focus-sync-relay): a small HTTP API on the user's own free Cloudflare account. */
export class RelayTransport implements SyncTransport {
  constructor(private http: HttpAdapter) {}
  private async call(base: string, method: 'GET' | 'POST', path: string, token: string, body?: unknown) {
    let res;
    try {
      res = await this.http.request({
        method,
        url: base.replace(/\/+$/, '') + path,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 30_000,
      });
    } catch (err) {
      throw new ValidationError(`Couldn’t reach the sync relay (${err instanceof Error ? err.message : 'network error'}). Changes are kept and will sync later.`);
    }
    let data: Record<string, unknown>;
    try {
      data = res.body ? JSON.parse(res.body) : {};
    } catch {
      throw new ValidationError(`The sync relay sent an unexpected answer (${res.status}). Check the relay address.`);
    }
    if (res.status === 401 || res.status === 403) throw new ValidationError('The sync relay refused this sync key.');
    if (res.status < 200 || res.status >= 300) throw new ValidationError(`Sync relay error ${res.status}: ${String(data.error ?? '')}`);
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
    return { batches: (r.batches as Batch[]) ?? [], more: !!r.more };
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
}

const SECRET = 'sync:key';
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

  constructor(
    private r: Repositories,
    private secrets: SecretStore,
    private transport: SyncTransport,
    private now: () => Date = () => new Date(),
  ) {}

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
    };
  }

  /** Time-based automations run on one device only, so they don't fire twice. */
  runsTimedAutomations(): boolean {
    return this.control().enabled !== 1 || this.meta('timedAutomations') !== '0';
  }
  setRunsTimedAutomations(on: boolean) {
    this.setMeta('timedAutomations', on ? '1' : '0');
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
  async enable(opts: { relayUrl: string; key?: string }): Promise<{ key: string }> {
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
    const derived = await deriveSyncKeys(key);
    const first = await this.transport.pull(url, derived.vaultId, derived.token, 0, 1);
    if (joining && first.batches.length === 0) throw new ValidationError('Nothing has been synced with this key yet. Check the key, or set up sync on the other device first.');
    if (joining && first.batches[0]) await openJson(derived, first.batches[0].data).catch(() => {
      throw new ValidationError('This key doesn’t match the data on the relay.');
    });
    // A new vault always gets a first (empty) batch, so other devices can join even if this one has no data yet.
    if (!joining) await this.transport.push(url, derived.vaultId, derived.token, this.control().device_id, await sealJson(derived, []));
    await this.secrets.set(SECRET, key);
    this.keys = { key, derived };
    this.r.db.transaction(() => {
      this.setMeta('relayUrl', url);
      this.setMeta('cursor', '0');
      this.setMeta('lastError', null);
      this.setMeta('timedAutomations', joining ? '0' : '1');
      this.r.db.run('UPDATE sync_control SET enabled = 1 WHERE id = 1');
      this.bootstrap();
    });
    await this.syncNow();
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
      const keys = await this.derived();
      await this.pull(keys);
      await this.push(keys);
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
