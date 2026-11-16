import type { SqlJsStatic } from 'sql.js';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import { integrityCheck, migrate, NewerSchemaError, pendingMigrations, currentSchemaVersion } from '@/data/migrations';
import type { Platform } from '@/platform/types';
import { createContainer, type AppContainer } from './container';

export type BootResult =
  | { status: 'ready'; app: AppContainer; recovered?: boolean }
  | { status: 'locked' }
  | { status: 'newer-schema'; message: string }
  | { status: 'corrupt'; details: string[]; hasPrevious: boolean; recover: () => Promise<BootResult>; startFresh: () => Promise<BootResult> }
  | { status: 'error'; error: Error };

function openVerified(sql: SqlJsStatic, bytes: Uint8Array | null): { ok: true; db: SqlJsDriver } | { ok: false; details: string[] } {
  let db: SqlJsDriver;
  try {
    db = new SqlJsDriver(sql, bytes);
  } catch (err) {
    return { ok: false, details: [`The database file could not be opened: ${(err as Error).message}`] };
  }
  if (bytes) {
    let check: { ok: boolean; messages: string[] };
    try {
      check = integrityCheck(db);
    } catch (err) {
      check = { ok: false, messages: [(err as Error).message] };
    }
    if (!check.ok) {
      db.close();
      return { ok: false, details: check.messages };
    }
  }
  return { ok: true, db };
}

/**
 * Start-up sequence: lock → load → integrity check → snapshot before migrating
 * → migrate → container. Never discards data without the user's say-so.
 */
export async function boot(sql: SqlJsStatic, platform: Platform): Promise<BootResult> {
  try {
    if (!(await platform.acquireLock())) return { status: 'locked' };
    void platform.persistence.requestDurable();

    const finish = async (db: SqlJsDriver, recovered = false): Promise<BootResult> => {
      try {
        const pending = pendingMigrations(db);
        if (pending.length && currentSchemaVersion(db) > 0) {
          // Keep an untouched copy of the pre-upgrade database (spec 7.6).
          await platform.persistence.saveSnapshot(`pre-migration-v${currentSchemaVersion(db)}`, db.export());
        }
        migrate(db);
      } catch (err) {
        db.close();
        if (err instanceof NewerSchemaError) return { status: 'newer-schema', message: err.message };
        throw err;
      }
      const app = createContainer(sql, (b) => new SqlJsDriver(sql, b), db, platform);
      // Always persist at start-up: a new database must exist on disk, and a migrated
      // one must be saved so the migration (and its snapshot) does not repeat next launch.
      await app.saver.flush(true);
      return { status: 'ready', app, recovered };
    };

    const bytes = await platform.persistence.load();
    const opened = openVerified(sql, bytes);
    if (opened.ok) return await finish(opened.db);

    const previous = await platform.persistence.loadPrevious();
    if (bytes) await platform.persistence.saveSnapshot(`corrupt-${new Date().toISOString()}`, bytes);
    const result: BootResult = {
      status: 'corrupt',
      details: opened.details,
      hasPrevious: !!previous,
      recover: async () => {
        const prev = openVerified(sql, previous);
        if (!prev.ok) return { status: 'error', error: new Error('The previous copy is also unreadable. Your damaged data has been kept as a snapshot.') };
        return finish(prev.db, true);
      },
      startFresh: async () => {
        const fresh = openVerified(sql, null);
        if (!fresh.ok) return { status: 'error', error: new Error('Could not create a new database') };
        return finish(fresh.db, true);
      },
    };
    return result;
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
