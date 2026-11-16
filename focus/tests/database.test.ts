import { describe, expect, it } from 'vitest';
import { boot } from '@/app/bootstrap';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import { currentSchemaVersion, integrityCheck, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, rollback } from '@/data/migrations';
import { createMemoryPlatform } from '@/platform/memory';
import { getSql, makeApp } from './helpers';

describe('driver', () => {
  it('rolls back a failed transaction completely and re-throws', async () => {
    const { db, app } = await makeApp();
    expect(() =>
      db.transaction(() => {
        app.tasks.create({ title: 'kept?' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(app.repos.tasks.listInbox()).toHaveLength(0);
  });

  it('nested savepoints roll back only the inner level', async () => {
    const { db, app } = await makeApp();
    db.transaction(() => {
      app.tasks.create({ title: 'outer' });
      try {
        db.transaction(() => {
          app.tasks.create({ title: 'inner' });
          throw new Error('inner fails');
        });
      } catch (e) {
        expect((e as Error).message).toBe('inner fails');
      }
    });
    expect(app.repos.tasks.listInbox().map((t) => t.title)).toEqual(['outer']);
  });

  it('notifies once per committed transaction', async () => {
    const { db, app } = await makeApp();
    let n = 0;
    db.subscribe(() => n++);
    db.transaction(() => {
      app.tasks.create({ title: 'a' });
      app.tasks.create({ title: 'b' });
    });
    expect(n).toBe(1);
  });

  it('enforces foreign keys even after export (sql.js resets pragmas)', async () => {
    const { db } = await makeApp();
    db.export();
    expect(() =>
      db.run("INSERT INTO sections (id, project_id, name, created_at, updated_at) VALUES ('s', 'missing', 'x', 'now', 'now')"),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('migrations', () => {
  it('migrates a new database to the latest version and passes integrity checks', async () => {
    const sql = await getSql();
    const db = new SqlJsDriver(sql);
    expect(migrate(db)).toEqual([1, 2]);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(integrityCheck(db).ok).toBe(true);
    expect(migrate(db)).toEqual([]); // idempotent
  });

  it('is reversible', async () => {
    const sql = await getSql();
    const db = new SqlJsDriver(sql);
    migrate(db);
    rollback(db, 0);
    expect(currentSchemaVersion(db)).toBe(0);
    expect(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")).toHaveLength(0);
    migrate(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('upgrades a v1 database in place, keeping data and a pre-migration snapshot', async () => {
    const sql = await getSql();
    const db = new SqlJsDriver(sql);
    migrate(db, [MIGRATIONS[0]!]);
    db.run("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'Old task', 'x', 'x')");
    const platform = createMemoryPlatform();
    platform.persistence.current = db.export();
    const r = await boot(sql, platform);
    if (r.status !== 'ready') throw new Error(r.status);
    expect(currentSchemaVersion(r.app.repos.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(r.app.repos.tasks.get('t1')?.title).toBe('Old task');
    expect(platform.persistence.snapshots.has('pre-migration-v1')).toBe(true);
  });

  it('refuses to open a database from a newer version without modifying it', async () => {
    const sql = await getSql();
    const db = new SqlJsDriver(sql);
    migrate(db);
    db.run("INSERT INTO schema_migrations VALUES (99, 'future', 'now')");
    const platform = createMemoryPlatform();
    platform.persistence.current = db.export();
    const before = platform.persistence.current;
    const r = await boot(sql, platform);
    expect(r.status).toBe('newer-schema');
    expect(platform.persistence.current).toBe(before);
  });
});

describe('persistence and boot', () => {
  it('data survives a restart', async () => {
    const sql = await getSql();
    const platform = createMemoryPlatform();
    const first = await boot(sql, platform);
    if (first.status !== 'ready') throw new Error(first.status);
    first.app.tasks.create({ title: 'Survive restart' });
    await first.app.saver.flush();
    first.app.dispose();

    const second = await boot(sql, platform);
    if (second.status !== 'ready') throw new Error(second.status);
    expect(second.app.repos.tasks.listInbox().map((t) => t.title)).toEqual(['Survive restart']);
  });

  it('detects a corrupt database, keeps it, and recovers the previous copy on request', async () => {
    const sql = await getSql();
    const platform = createMemoryPlatform();
    const first = await boot(sql, platform);
    if (first.status !== 'ready') throw new Error(first.status);
    first.app.tasks.create({ title: 'Good data' });
    await first.app.saver.flush();
    first.app.tasks.create({ title: 'More' });
    await first.app.saver.flush();
    first.app.dispose();

    const damaged = new Uint8Array(platform.persistence.current!);
    damaged.fill(7, 100, 4000); // corrupt the header/pages
    platform.persistence.current = damaged;

    const r = await boot(sql, platform);
    expect(r.status).toBe('corrupt');
    if (r.status !== 'corrupt') return;
    expect(r.hasPrevious).toBe(true);
    expect([...platform.persistence.snapshots.keys()].some((k) => k.startsWith('corrupt-'))).toBe(true);
    const rec = await r.recover();
    if (rec.status !== 'ready') throw new Error(rec.status);
    expect(rec.app.repos.tasks.listInbox().map((t) => t.title)).toContain('Good data');
  });

  it('a second window is refused rather than overwriting data', async () => {
    const sql = await getSql();
    const platform = createMemoryPlatform();
    platform.acquireLock = async () => false;
    expect((await boot(sql, platform)).status).toBe('locked');
  });
});
