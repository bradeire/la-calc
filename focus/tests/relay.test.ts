import { describe, expect, it } from 'vitest';
import { fakeRelay } from './relay';

const V = 'a'.repeat(32);
const T1 = '1'.repeat(64);
const T2 = '2'.repeat(64);

describe('sync relay worker', () => {
  it('serves the static tap-to-add page, which carries no task text', async () => {
    const { http } = await fakeRelay();
    const r = await http({ method: 'GET', url: 'https://relay.test/open' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Open in Focus');
    expect(r.body).toContain('location.hash');
    expect(JSON.parse((await http({ method: 'GET', url: 'https://relay.test/v1/health' })).body)).toMatchObject({ version: 3, open: true });
  });

  it('creates a vault on first upload and only accepts its token afterwards', async () => {
    const { http, db } = await fakeRelay();
    const base = 'https://relay.test';
    const post = (token: string, body: unknown) => http({ method: 'POST', url: `${base}/v1/vaults/${V}/batches`, headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const get = (token: string, q = 'after=0') => http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?${q}`, headers: { Authorization: `Bearer ${token}` } });

    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/health` })).body)).toMatchObject({ ok: true });
    expect(JSON.parse((await get(T1)).body)).toEqual({ batches: [], more: false, snapshot: null });
    expect((await post(T1, { device: 'dev-a', data: 'QUJD' })).status).toBe(201);
    expect((await post(T2, { device: 'dev-b', data: 'QUJD' })).status).toBe(403);
    expect((await get(T2)).status).toBe(403);
    expect((await get('not-a-token')).status).toBe(403);
    // The token itself is never stored, only its hash.
    expect(JSON.stringify(db.exec('SELECT * FROM vaults'))).not.toContain(T1);

    await post(T1, { device: 'dev-a', data: 'REVG' });
    const page = JSON.parse((await get(T1, 'after=0&limit=1')).body);
    expect(page).toMatchObject({ batches: [{ seq: 1, device: 'dev-a', data: 'QUJD' }], more: true });
    expect(JSON.parse((await get(T1, 'after=1')).body).batches.map((b: { seq: number }) => b.seq)).toEqual([2]);
  });

  it('validates uploads, answers CORS preflight, and can erase a vault', async () => {
    const { http } = await fakeRelay();
    const base = 'https://relay.test';
    const post = (body: unknown, path = 'batches') => http({ method: 'POST', url: `${base}/v1/vaults/${V}/${path}`, headers: { Authorization: `Bearer ${T1}` }, body: JSON.stringify(body) });
    expect((await post({ device: 'Bad Device!', data: 'QUJD' })).status).toBe(400);
    expect((await post({ device: 'd', data: '<script>' })).status).toBe(400);
    expect((await post({ device: 'd', data: 'A'.repeat(1_500_001) })).status).toBe(400);
    expect((await http({ method: 'GET', url: `${base}/v1/vaults/short/batches` })).status).toBe(404);
    const pre = await http({ method: 'OPTIONS' as 'GET', url: `${base}/v1/vaults/${V}/batches` });
    expect(pre.status).toBe(204);
    await post({ device: 'd', data: 'QUJD' });
    expect(JSON.parse((await post({}, 'delete')).body)).toEqual({ deleted: true });
    const after = await http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?after=0`, headers: { Authorization: `Bearer ${T2}` } });
    // Erased: the vault is free again, so any token sees it empty.
    expect(JSON.parse(after.body)).toEqual({ batches: [], more: false, snapshot: null });
  });

  it('enforces the storage quota and reports usage', async () => {
    const { http } = await fakeRelay({ QUOTA_BYTES: '10' });
    const base = 'https://relay.test';
    const h = { Authorization: `Bearer ${T1}` };
    expect((await http({ method: 'POST', url: `${base}/v1/vaults/${V}/batches`, headers: h, body: JSON.stringify({ device: 'd', data: 'QUJDREVG' }) })).status).toBe(201);
    const full = await http({ method: 'POST', url: `${base}/v1/vaults/${V}/batches`, headers: h, body: JSON.stringify({ device: 'd', data: 'QUJDREVG' }) });
    expect(full.status).toBe(507);
    expect(JSON.parse(full.body).code).toBe('quota');
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/usage`, headers: h })).body)).toMatchObject({ bytes: 8, quota: 10, batches: 1 });
  });

  it('rate-limits per vault and per IP, and limits new vaults per IP', async () => {
    const { http } = await fakeRelay({ RATE_PER_MINUTE: '3', VAULTS_PER_IP_PER_DAY: '1' });
    const base = 'https://relay.test';
    const get = () => http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches`, headers: { Authorization: `Bearer ${T1}` } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await get()).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const make = (vault: string) => http({ method: 'POST', url: `${base}/v1/vaults/${vault}/batches`, headers: { Authorization: `Bearer ${T2}` }, body: JSON.stringify({ device: 'd', data: 'QUJD' }) });
    expect((await make('c'.repeat(32))).status).toBe(201);
    expect((await make('d'.repeat(32))).status).toBe(429);

    const ipLimited = await fakeRelay({ IP_RATE_PER_MINUTE: '2' });
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await ipLimited.http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches`, headers: { Authorization: `Bearer ${T1}`, 'CF-Connecting-IP': '203.0.113.9' } })).status);
    expect(st).toEqual([200, 200, 429]);
  });

  it('requires a valid, unexpired licence to create a vault when the relay is licensed', async () => {
    const { createHmac } = await import('node:crypto');
    const secret = 'relay-secret';
    const lic = (id: string, expires: number) => `${id}.${expires}.${createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex')}`;
    const { http } = await fakeRelay({ LICENCE_SECRET: secret, VAULTS_PER_LICENCE: '1' });
    const base = 'https://relay.test';
    const post = (vault: string, licence?: string) =>
      http({ method: 'POST', url: `${base}/v1/vaults/${vault}/batches`, headers: { Authorization: `Bearer ${T1}`, ...(licence ? { 'X-Focus-Licence': licence } : {}) }, body: JSON.stringify({ device: 'd', data: 'QUJD' }) });
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/health` })).body).licenceRequired).toBe(true);
    expect(JSON.parse((await post(V)).body).code).toBe('licence_required');
    expect((await post(V, lic('cust1', 0).replace(/.$/, '0'))).status).toBe(402);
    expect(JSON.parse((await post(V, lic('cust1', 1000))).body).code).toBe('licence_expired');
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await post(V, lic('cust1', future))).status).toBe(201);
    // Existing vault: writes work without resending the licence until it expires.
    expect((await post(V)).status).toBe(201);
    expect(JSON.parse((await post('e'.repeat(32), lic('cust1', future))).body).code).toBe('licence_used');
  });

  it('compacts: a complete snapshot replaces the batches it covers, and late devices are pointed to it', async () => {
    const { http } = await fakeRelay();
    const base = 'https://relay.test';
    const h = { Authorization: `Bearer ${T1}` };
    for (const d of ['QQ==', 'Qg==', 'Qw==']) await http({ method: 'POST', url: `${base}/v1/vaults/${V}/batches`, headers: h, body: JSON.stringify({ device: 'd', data: d }) });
    const part = (n: number, data: string, upTo = 2) => http({ method: 'POST', url: `${base}/v1/vaults/${V}/snapshots/snap-0001/parts/${n}`, headers: h, body: JSON.stringify({ parts: 2, upTo, data }) });
    expect(JSON.parse((await part(0, 'U0E=')).body)).toEqual({ complete: false });
    // Not complete yet: nothing is deleted.
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?after=0`, headers: h })).body).batches).toHaveLength(3);
    expect(JSON.parse((await part(1, 'U0I=')).body)).toEqual({ complete: true, upTo: 2 });
    const behind = JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?after=0`, headers: h })).body);
    expect(behind).toEqual({ batches: [], more: true, snapshot: { id: 'snap-0001', upTo: 2, parts: 2 } });
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/snapshots/snap-0001/parts/1`, headers: h })).body)).toEqual({ data: 'U0I=' });
    const after = JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?after=2`, headers: h })).body);
    expect(after.batches.map((b: { seq: number }) => b.seq)).toEqual([3]);
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/usage`, headers: h })).body)).toMatchObject({ batches: 1, bytes: 4 + 8 });
    expect((await part(0, 'QQ==', 99)).status).toBe(409);
  });

  it('stores attachment files in parts and deletes them', async () => {
    const { http } = await fakeRelay();
    const base = 'https://relay.test';
    const h = { Authorization: `Bearer ${T1}` };
    const blob = `${base}/v1/vaults/${V}/blobs/file-0001`;
    expect(JSON.parse((await http({ method: 'GET', url: blob, headers: h })).body)).toEqual({ blob: null });
    await http({ method: 'POST', url: `${blob}/parts/1`, headers: h, body: JSON.stringify({ parts: 2, data: 'Qg==' }) });
    expect(JSON.parse((await http({ method: 'GET', url: blob, headers: h })).body)).toEqual({ blob: { parts: 2, complete: false } });
    await http({ method: 'POST', url: `${blob}/parts/0`, headers: h, body: JSON.stringify({ parts: 2, data: 'QQ==' }) });
    expect(JSON.parse((await http({ method: 'GET', url: blob, headers: h })).body)).toEqual({ blob: { parts: 2, complete: true } });
    expect(JSON.parse((await http({ method: 'GET', url: `${blob}/parts/0`, headers: h })).body)).toEqual({ data: 'QQ==' });
    await http({ method: 'POST', url: `${blob}/delete`, headers: h, body: '{}' });
    expect(JSON.parse((await http({ method: 'GET', url: blob, headers: h })).body)).toEqual({ blob: null });
    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/vaults/${V}/usage`, headers: h })).body).bytes).toBe(0);
  });

  it('upgrades a relay created by the first version in place', async () => {
    const { http, db } = await fakeRelay();
    db.run('CREATE TABLE vaults (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.run('CREATE TABLE batches (seq INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, device TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)');
    const { createHash } = await import('node:crypto');
    db.run('INSERT INTO vaults VALUES (?, ?, ?)', [V, createHash('sha256').update(T1).digest('hex'), '2026-11-16']);
    db.run("INSERT INTO batches (vault, device, data, created_at) VALUES (?, 'old', 'T0xE', '2026-11-16')", [V]);
    const h = { Authorization: `Bearer ${T1}` };
    const page = JSON.parse((await http({ method: 'GET', url: `https://relay.test/v1/vaults/${V}/batches?after=0`, headers: h })).body);
    expect(page.batches).toEqual([{ seq: 1, device: 'old', data: 'T0xE' }]);
    expect((await http({ method: 'POST', url: `https://relay.test/v1/vaults/${V}/batches`, headers: h, body: JSON.stringify({ device: 'new', data: 'TkVX' }) })).status).toBe(201);
  });
});
