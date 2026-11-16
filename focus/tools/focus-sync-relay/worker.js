// Focus sync relay — a Cloudflare Worker with a D1 database (both on Cloudflare's free plan).
//
// It stores and hands back ENCRYPTED batches of changes. It never receives the encryption key:
// devices derive it from the sync key, and only a hash of a separate access token is stored here.
// See README.md for setup. Tables are created automatically on first use.

const MAX_DATA = 1_500_000; // characters of base64 per batch
const MAX_BATCHES_PER_VAULT = 200_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const schemaReady = new WeakSet();
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, created_at TEXT NOT NULL)').run();
  await db
    .prepare('CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, device TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)')
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_batches_vault ON batches (vault, seq)').run();
  schemaReady.add(db);
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Returns 'ok', 'new' (vault doesn't exist yet) or 'denied'. */
async function authorise(db, vault, request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return { state: 'denied' };
  const hash = await sha256Hex(token);
  const row = await db.prepare('SELECT auth_hash FROM vaults WHERE id = ?').bind(vault).first();
  if (!row) return { state: 'new', hash };
  return { state: same(row.auth_hash, hash) ? 'ok' : 'denied', hash };
}

export async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (url.pathname === '/v1/health') return json({ ok: true, app: 'focus-sync-relay' });
  if (!env.DB) return json({ error: 'The relay has no database: bind a D1 database as DB (see README)' }, 500);
  await ensureSchema(env.DB);

  const m = url.pathname.match(/^\/v1\/vaults\/([0-9a-f]{32})\/(batches|delete)$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const [, vault, action] = m;
  const auth = await authorise(env.DB, vault, request);
  if (auth.state === 'denied') return json({ error: 'Wrong sync key' }, 403);

  if (action === 'batches' && request.method === 'GET') {
    if (auth.state === 'new') return json({ batches: [], more: false });
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const { results } = await env.DB.prepare('SELECT seq, device, data FROM batches WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?').bind(vault, after, limit + 1).all();
    return json({ batches: results.slice(0, limit), more: results.length > limit });
  }

  if (action === 'batches' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }
    if (typeof body.device !== 'string' || !/^[0-9a-z-]{1,64}$/.test(body.device)) return json({ error: 'Bad device id' }, 400);
    if (typeof body.data !== 'string' || !body.data || body.data.length > MAX_DATA || !/^[A-Za-z0-9+/=]+$/.test(body.data)) return json({ error: 'Bad or oversized data' }, 400);
    const now = new Date().toISOString();
    if (auth.state === 'new') {
      await env.DB.prepare('INSERT OR IGNORE INTO vaults (id, auth_hash, created_at) VALUES (?, ?, ?)').bind(vault, auth.hash, now).run();
      // Another device may have created it a moment ago with a different key.
      const again = await authorise(env.DB, vault, request);
      if (again.state !== 'ok') return json({ error: 'Wrong sync key' }, 403);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM batches WHERE vault = ?').bind(vault).first();
    if (count && count.n >= MAX_BATCHES_PER_VAULT) return json({ error: 'This vault is full' }, 507);
    const r = await env.DB.prepare('INSERT INTO batches (vault, device, data, created_at) VALUES (?, ?, ?, ?)').bind(vault, body.device, body.data, now).run();
    return json({ seq: r.meta.last_row_id }, 201);
  }

  // Erase everything stored for this vault (used when the user turns sync off everywhere).
  if (action === 'delete' && request.method === 'POST') {
    if (auth.state === 'new') return json({ deleted: true });
    await env.DB.prepare('DELETE FROM batches WHERE vault = ?').bind(vault).run();
    await env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(vault).run();
    return json({ deleted: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: 'Relay error' }, 500);
    }
  },
};
