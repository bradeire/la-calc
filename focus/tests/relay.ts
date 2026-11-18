// Test harness: the real relay worker (tools/focus-sync-relay/worker.js) over a D1 stand-in
// backed by sql.js, exposed to Focus through the platform's HttpAdapter.
import type { HttpRequest, HttpResponse } from '@/platform/types';
// @ts-expect-error plain JS module without types
import { handle } from '../tools/focus-sync-relay/worker.js';
import { getSql } from './helpers';

type D1Value = string | number | null;

/** Minimal D1 API: prepare().bind().first()/all()/run(). */
export async function fakeD1() {
  const SQL = await getSql();
  const db = new SQL.Database();
  const prepared = (sql: string, params: D1Value[] = []) => ({
    bind: (...p: D1Value[]) => prepared(sql, p),
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
      const id = db.exec('SELECT last_insert_rowid()')[0]!.values[0]![0] as number;
      return { meta: { last_row_id: id } };
    },
  });
  return { prepare: (sql: string) => prepared(sql), raw: db };
}

export async function fakeRelay(vars: Record<string, string> = {}) {
  const DB = await fakeD1();
  const env = { DB, ...vars };
  const requests: HttpRequest[] = [];
  let offline = false;
  const http = async (r: HttpRequest): Promise<HttpResponse> => {
    requests.push(r);
    if (offline) throw new Error('offline');
    const res: Response = await handle(new Request(r.url, { method: r.method, headers: r.headers, body: r.body }), env);
    return { status: res.status, body: await res.text() };
  };
  return {
    http,
    requests,
    db: DB.raw,
    setOffline: (v: boolean) => {
      offline = v;
    },
  };
}
