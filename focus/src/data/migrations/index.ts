import type { DatabaseDriver } from '../db/driver';
import { migration001 } from './001_initial';
import { migration002 } from './002_task_order_index';
import type { Migration } from './types';

export const MIGRATIONS: readonly Migration[] = [migration001, migration002];
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function ensureTable(db: DatabaseDriver) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
}

export function currentSchemaVersion(db: DatabaseDriver): number {
  ensureTable(db);
  return db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
}

export function pendingMigrations(db: DatabaseDriver, migrations = MIGRATIONS): Migration[] {
  const v = currentSchemaVersion(db);
  return migrations.filter((m) => m.version > v);
}

export class NewerSchemaError extends Error {
  constructor(public readonly found: number, public readonly supported: number) {
    super(`This database was created by a newer version of Focus (schema v${found}; this version supports v${supported}). It has not been modified.`);
  }
}

/**
 * Apply pending migrations, each in its own transaction. A failure rolls back
 * that migration and stops; earlier migrations remain applied.
 */
export function migrate(db: DatabaseDriver, migrations = MIGRATIONS): number[] {
  const current = currentSchemaVersion(db);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (current > latest) throw new NewerSchemaError(current, latest);
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
    });
    applied.push(m.version);
  }
  return applied;
}

/** Roll back down to (but not including) `target`. Destructive — callers must obtain consent and back up first. */
export function rollback(db: DatabaseDriver, target: number, migrations = MIGRATIONS): number[] {
  const current = currentSchemaVersion(db);
  const reverted: number[] = [];
  for (const m of [...migrations].reverse()) {
    if (m.version > current || m.version <= target) continue;
    db.transaction(() => {
      db.exec(m.down);
      db.run('DELETE FROM schema_migrations WHERE version = ?', [m.version]);
    });
    reverted.push(m.version);
  }
  return reverted;
}

export function integrityCheck(db: DatabaseDriver): { ok: boolean; messages: string[] } {
  const rows = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
  const messages = rows.map((r) => r.integrity_check);
  const fk = db.all<Record<string, unknown>>('PRAGMA foreign_key_check');
  if (fk.length) messages.push(`${fk.length} foreign-key violation(s)`);
  return { ok: messages.length === 1 && messages[0] === 'ok' && fk.length === 0, messages };
}
