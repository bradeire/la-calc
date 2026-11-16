// The real sync relay (tools/focus-sync-relay/worker.js) running inside the test process,
// with a D1 stand-in on sql.js. Browser pages reach it through page.route().
import initSqlJs from 'sql.js';
import type { BrowserContext, Route } from '@playwright/test';
// @ts-expect-error plain JS module
import { handle } from '../tools/focus-sync-relay/worker.js';

export async function startRelay() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  type V = string | number | null;
  const prepared = (sql: string, params: V[] = []) => ({
    bind: (...p: V[]) => prepared(sql, p),
    async all() {
      const s = db.prepare(sql);
      s.bind(params as never);
      const results: Record<string, unknown>[] = [];
      while (s.step()) results.push(s.getAsObject());
      s.free();
      return { results };
    },
    async first() {
      return (await this.all()).results[0] ?? null;
    },
    async run() {
      db.run(sql, params as never);
      return { meta: { last_row_id: db.exec('SELECT last_insert_rowid()')[0]!.values[0]![0] } };
    },
  });
  const env = { DB: { prepare: (sql: string) => prepared(sql) } };
  const serve = async (route: Route) => {
    const req = route.request();
    const res: Response = await handle(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.method() === 'POST' ? req.postData() : undefined }), env);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
  };
  return {
    attach: (ctx: BrowserContext) => ctx.route('https://relay.test/**', serve),
    stored: () => JSON.stringify(db.exec('SELECT data FROM batches')),
  };
}
