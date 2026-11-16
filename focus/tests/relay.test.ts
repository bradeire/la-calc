import { describe, expect, it } from 'vitest';
import { fakeRelay } from './relay';

const V = 'a'.repeat(32);
const T1 = '1'.repeat(64);
const T2 = '2'.repeat(64);

describe('sync relay worker', () => {
  it('creates a vault on first upload and only accepts its token afterwards', async () => {
    const { http, db } = await fakeRelay();
    const base = 'https://relay.test';
    const post = (token: string, body: unknown) => http({ method: 'POST', url: `${base}/v1/vaults/${V}/batches`, headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const get = (token: string, q = 'after=0') => http({ method: 'GET', url: `${base}/v1/vaults/${V}/batches?${q}`, headers: { Authorization: `Bearer ${token}` } });

    expect(JSON.parse((await http({ method: 'GET', url: `${base}/v1/health` })).body)).toMatchObject({ ok: true });
    expect(JSON.parse((await get(T1)).body)).toEqual({ batches: [], more: false });
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
    expect(JSON.parse(after.body)).toEqual({ batches: [], more: false });
  });
});
