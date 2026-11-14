import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { createContainer } from '@/app/container';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import { migrate } from '@/data/migrations';
import { createMemoryPlatform } from '@/platform/memory';

let sqlPromise: Promise<SqlJsStatic> | null = null;
export const getSql = () => (sqlPromise ??= initSqlJs());

/** A fully wired application container on a fresh in-memory database. */
export async function makeApp(now = new Date(2026, 10, 14, 10, 0)) {
  const sql = await getSql();
  const db = new SqlJsDriver(sql);
  migrate(db);
  const platform = createMemoryPlatform();
  const clock = { now: () => now };
  const app = createContainer(sql, (b) => new SqlJsDriver(sql, b), db, platform, clock);
  return { app, platform, sql, db };
}
