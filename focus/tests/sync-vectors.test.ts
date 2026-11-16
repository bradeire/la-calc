/**
 * Shared test vectors between the TypeScript sync engine and its Rust port (src-tauri/src/bgsync.rs).
 * Run with GENERATE_SYNC_VECTORS=1 to (re)create the fixtures from the TypeScript engine; normally
 * this checks the TypeScript engine still produces exactly the recorded results. The Rust tests
 * check the Rust engine against the same files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainer } from '@/app/container';
import { deriveSyncKeys, openJson, sealJson } from '@/core/sync/crypto';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import type { DatabaseDriver } from '@/data/db/driver';
import { createMemoryPlatform } from '@/platform/memory';
import type { SyncItem } from '@/services/sync-service';
import { getSql, makeApp } from './helpers';
import { fakeRelay } from './relay';

const DIR = resolve(__dirname, '../src-tauri/tests/fixtures');
const RELAY = 'https://relay.example.workers.dev';
const DUMP_TABLES = ['projects', 'sections', 'labels', 'tasks', 'recurrence_rules', 'task_labels', 'task_dependencies', 'comments', 'settings', 'sync_fields', 'sync_tombstones'];

export function dump(db: DatabaseDriver) {
  const out: Record<string, unknown[]> = {};
  for (const t of DUMP_TABLES) {
    const rows = db.all(`SELECT * FROM ${t}`) as Record<string, unknown>[];
    out[t] = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  }
  const c = db.get<{ hlc_ms: number; hlc_counter: number }>('SELECT hlc_ms, hlc_counter FROM sync_control')!;
  out.clock = [c.hlc_ms, c.hlc_counter];
  out.waiting = [db.get<{ value: string }>("SELECT value FROM sync_meta WHERE key = 'waiting'")?.value ?? null];
  return out;
}

async function generate() {
  mkdirSync(DIR, { recursive: true });
  const relay = await fakeRelay();
  const A = await makeApp();
  const B = await makeApp();
  A.platform.http.handler = relay.http;
  B.platform.http.handler = relay.http;
  const a = A.app;
  const b = B.app;
  const home = a.projects.create({ name: 'Home' });
  a.labels.create({ name: 'garden' });
  const t1 = a.tasks.create({ title: 'Paint fence', projectId: home.id, priority: 3 });
  a.tasks.create({ title: 'Doomed', projectId: home.id });
  const { key } = await a.sync.enable({ relayUrl: RELAY });
  await b.sync.enable({ relayUrl: RELAY, key });
  // B makes concurrent changes: a field edit, a new task with a label of the same name (clash),
  // a deletion, a new project and a comment.
  b.tasks.update(t1.id, { scheduledDate: '2026-11-21' });
  a.tasks.update(t1.id, { title: 'Paint the fence' });
  const doomed = b.repos.tasks.listForReports().find((t) => t.title === 'Doomed')!;
  b.tasks.remove([doomed.id]);
  b.tasks.purge(doomed.id);
  const work = b.projects.create({ name: 'Work' });
  const t2 = b.tasks.create({ title: 'Quarterly report', projectId: work.id, deadline: '2026-12-01' });
  b.content.addComment(t2.id, 'Use the new template');
  b.repos.settings.set('weekStartsOn', 0);
  // Both create a label with the same name before syncing: settled by id on every device.
  a.labels.create({ name: 'errands' });
  b.labels.create({ name: 'errands' });
  const items = (b.sync as unknown as { allItems(): SyncItem[] }).allItems();
  // An orphan (parent missing): must wait, not fail.
  items.push({ t: 'tasks', k: 'ffffffff-ffff-4fff-8fff-ffffffffffff', f: { id: ['ffffffff-ffff-4fff-8fff-ffffffffffff', '9999999999999-00000-zz'], title: ['Orphan', '9999999999999-00000-zz'], project_id: ['00000000-0000-4000-8000-000000000000', '9999999999999-00000-zz'], priority: [4, '9999999999999-00000-zz'], status: ['active', '9999999999999-00000-zz'], created_at: ['2026-11-16T00:00:00.000Z', '9999999999999-00000-zz'], updated_at: ['2026-11-16T00:00:00.000Z', '9999999999999-00000-zz'], sort_order: [0, '9999999999999-00000-zz'] } });

  const base = A.db.export();
  writeFileSync(resolve(DIR, 'base.sqlite'), base);
  const keys = await deriveSyncKeys(key);
  const sealed = await sealJson(keys, items.slice(0, 3));
  writeFileSync(resolve(DIR, 'vectors.json'), JSON.stringify({ key, vaultId: keys.vaultId, token: keys.token, sealed, sealedItems: items.slice(0, 3), items }, null, 1));
  const expected = await applyInFresh(base, items);
  writeFileSync(resolve(DIR, 'expected.json'), JSON.stringify(expected, null, 1));
}

async function applyInFresh(bytes: Uint8Array, items: SyncItem[]) {
  const sql = await getSql();
  const db = new SqlJsDriver(sql, bytes);
  const app = createContainer(sql, (x) => new SqlJsDriver(sql, x), db, createMemoryPlatform());
  app.sync.apply(items);
  return dump(db);
}

describe('sync test vectors (TypeScript side)', () => {
  it('match the recorded fixtures', async () => {
    if (process.env.GENERATE_SYNC_VECTORS) await generate();
    if (!existsSync(resolve(DIR, 'vectors.json'))) return;
    const v = JSON.parse(readFileSync(resolve(DIR, 'vectors.json'), 'utf8'));
    const keys = await deriveSyncKeys(v.key);
    expect({ vaultId: keys.vaultId, token: keys.token }).toEqual({ vaultId: v.vaultId, token: v.token });
    expect(await openJson(keys, v.sealed)).toEqual(v.sealedItems);
    const base = new Uint8Array(readFileSync(resolve(DIR, 'base.sqlite')));
    expect(await applyInFresh(base, v.items)).toEqual(JSON.parse(readFileSync(resolve(DIR, 'expected.json'), 'utf8')));
    // Data sealed by the Rust engine opens here too.
    const rust = resolve(DIR, 'rust-sealed.json');
    if (existsSync(rust)) {
      const r = JSON.parse(readFileSync(rust, 'utf8'));
      expect(await openJson(keys, r.sealed)).toEqual(r.items);
    }
  });
});
