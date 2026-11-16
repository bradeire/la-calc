/**
 * Cross-engine end-to-end: two TypeScript devices and the Rust background engine (bgsync.rs)
 * syncing through the real relay code over HTTP. Slow (compiles Rust), so it runs only with
 * BGSYNC_E2E=1:  BGSYNC_E2E=1 npx vitest run tests/bgsync-e2e.test.ts
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContainer } from '@/app/container';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import { createMemoryPlatform } from '@/platform/memory';
import type { HttpRequest } from '@/platform/types';
// @ts-expect-error plain JS module
import { handle } from '../tools/focus-sync-relay/worker.js';
import { getSql, makeApp } from './helpers';
import { fakeD1 } from './relay';

describe.skipIf(!process.env.BGSYNC_E2E)('background sync engine (Rust) with TypeScript devices', () => {
  it('pulls and pushes through the real relay over HTTP', async () => {
    const DB = await fakeD1();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const r: Response = await handle(
          new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? body : undefined }),
          { DB },
        );
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(await r.text());
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fetchHttp = async (r: HttpRequest) => {
      const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
      return { status: res.status, body: await res.text() };
    };
    try {
      const A = await makeApp();
      const B = await makeApp();
      A.platform.http.handler = fetchHttp;
      B.platform.http.handler = fetchHttp;
      const { key } = await A.app.sync.enable({ relayUrl: url });
      await B.app.sync.enable({ relayUrl: url, key });

      // Phone (B) goes to the background with an unsent change; desktop (A) adds a task.
      B.app.tasks.create({ title: 'Written on the phone before closing it' });
      A.app.tasks.create({ title: 'Added on the desktop while the phone app is closed' });
      await A.app.sync.syncNow();

      // The phone's database file, as the app saves it, synced by the Rust engine.
      const root = mkdtempSync(join(tmpdir(), 'focus-bg-'));
      writeFileSync(join(root, 'focus.sqlite'), B.db.export());
      // Async, so this process's relay server keeps answering while Rust runs.
      const { stdout: out } = await promisify(execFile)('cargo', ['test', '--quiet', '--lib', 'bgsync::tests::external_sync', '--', '--ignored', '--nocapture'], {
        cwd: resolve(__dirname, '../src-tauri'),
        env: { ...process.env, FOCUS_BG_ROOT: root, FOCUS_BG_KEY: key },
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(out).toMatch(/BGSYNC pulled=\d+ pushed=\d+/);

      // The phone app reopens with the file the background job wrote.
      const sql = await getSql();
      const reopened = new SqlJsDriver(sql, new Uint8Array(readFileSync(join(root, 'focus.sqlite'))));
      const phone = createContainer(sql, (x) => new SqlJsDriver(sql, x), reopened, createMemoryPlatform());
      expect(phone.repos.tasks.listForReports().map((t) => t.title)).toContain('Added on the desktop while the phone app is closed');
      expect(phone.sync.status().pending).toBe(0);

      // The desktop receives what the background job pushed.
      await A.app.sync.syncNow();
      expect(A.app.repos.tasks.listForReports().map((t) => t.title)).toContain('Written on the phone before closing it');
    } finally {
      server.close();
    }
  }, 600_000);
});
