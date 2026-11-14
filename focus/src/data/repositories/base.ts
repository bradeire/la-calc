import type { DatabaseDriver, SqlValue } from '../db/driver';

export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

export const bool = (v: SqlValue | undefined): boolean => v === 1 || v === '1';
export const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
export const strOrNull = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));
export const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
export const numOrNull = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));

let deviceId: string | null = null;

export function getDeviceId(db: DatabaseDriver): string {
  if (deviceId) return deviceId;
  const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'deviceId'");
  if (row) {
    deviceId = JSON.parse(row.value_json) as string;
  } else {
    deviceId = newId();
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('deviceId', ?, ?)", [JSON.stringify(deviceId), nowIso()]);
  }
  return deviceId;
}

export function resetDeviceIdCache() {
  deviceId = null;
}

/** Record a change for future synchronisation (ADR-004). */
export function track(db: DatabaseDriver, entity: string, id: string, op: 'insert' | 'update' | 'delete') {
  db.run('INSERT INTO change_log (entity, entity_id, op, changed_at, device_id) VALUES (?, ?, ?, ?, ?)', [
    entity,
    id,
    op,
    nowIso(),
    getDeviceId(db),
  ]);
}

/** Build "a = ?, b = ?" for a column→value map. */
export function setClause(cols: Record<string, SqlValue>): { sql: string; values: SqlValue[] } {
  const keys = Object.keys(cols);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => cols[k]!) };
}

export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
