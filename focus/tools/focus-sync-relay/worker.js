// Focus sync relay — a Cloudflare Worker with a D1 database.
//
// Stores and hands back ENCRYPTED data: batches of changes, snapshots (for compaction) and
// attachment files, split into parts. It never receives the encryption key: devices derive it
// from the sync key, and only a hash of a separate access token is stored here.
//
// Settings (Worker → Settings → Variables), all optional:
//   QUOTA_BYTES            storage per vault (default 100 MB)
//   RATE_PER_MINUTE        requests per vault per minute (default 240)
//   IP_RATE_PER_MINUTE     requests per IP address per minute (default 600)
//   VAULTS_PER_IP_PER_DAY  new vaults per IP address per day (default 5)
//   LICENCE_SECRET         if set, creating a vault needs a licence signed with it, and writes
//                          stop (reads keep working) when the licence expires. See mint-licence.mjs.
//   VAULTS_PER_LICENCE     vaults one licence may create (default 3)
// Tables are created and upgraded automatically.

const MAX_PART = 1_500_000; // characters of base64 per stored part
const MAX_PARTS = 100;
const DAY = 86_400;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Focus-Licence',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const now = () => Math.floor(Date.now() / 1000);

function config(env) {
  return {
    quota: num(env.QUOTA_BYTES, 100 * 1024 * 1024),
    vaultRate: num(env.RATE_PER_MINUTE, 240),
    ipRate: num(env.IP_RATE_PER_MINUTE, 600),
    vaultsPerIp: num(env.VAULTS_PER_IP_PER_DAY, 5),
    licenceSecret: env.LICENCE_SECRET || '',
    vaultsPerLicence: num(env.VAULTS_PER_LICENCE, 3),
  };
}

const schemaReady = new WeakSet();
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  const stmts = [
    'CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY AUTOINCREMENT, vault TEXT NOT NULL, device TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_batches_vault ON batches (vault, seq)',
    'CREATE TABLE IF NOT EXISTS snapshots (vault TEXT NOT NULL, id TEXT NOT NULL, up_to INTEGER NOT NULL, parts INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (vault, id))',
    'CREATE TABLE IF NOT EXISTS snapshot_parts (vault TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (vault, id, part))',
    'CREATE TABLE IF NOT EXISTS blobs (vault TEXT NOT NULL, id TEXT NOT NULL, parts INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (vault, id))',
    'CREATE TABLE IF NOT EXISTS blob_parts (vault TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (vault, id, part))',
    'CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)',
  ];
  for (const s of stmts) await db.prepare(s).run();
  // Upgrades from the first relay version.
  for (const s of [
    'ALTER TABLE vaults ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE vaults ADD COLUMN licence_id TEXT',
    'ALTER TABLE vaults ADD COLUMN licence_expires INTEGER',
    'ALTER TABLE batches ADD COLUMN size INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      await db.prepare(s).run();
    } catch {
      // column already exists
    }
  }
  schemaReady.add(db);
}

const enc = new TextEncoder();
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Licence: "<id>.<expires unix seconds, 0 = never>.<hmac>". Returns { id, expires } or null. */
async function verifyLicence(secret, header) {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(header || '');
  if (!m) return null;
  const expected = await hmacHex(secret, `${m[1]}.${m[2]}`);
  if (!same(expected, m[3])) return null;
  return { id: m[1], expires: Number(m[2]) };
}

/** Fixed-window counter. Returns true if the request is within the limit. */
async function allow(db, key, windowSec, limit) {
  if (limit <= 0) return true;
  const w = Math.floor(now() / windowSec) * windowSec;
  const row = await db
    .prepare('INSERT INTO counters (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window RETURNING count')
    .bind(key, w)
    .first();
  if (Math.random() < 0.01) await db.prepare('DELETE FROM counters WHERE window < ?').bind(now() - 2 * DAY).run();
  return !row || row.count <= limit;
}

async function authorise(db, vault, request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return { state: 'denied' };
  const hash = await sha256Hex(token);
  const row = await db.prepare('SELECT auth_hash, bytes, licence_id, licence_expires FROM vaults WHERE id = ?').bind(vault).first();
  if (!row) return { state: 'new', hash };
  return same(row.auth_hash, hash) ? { state: 'ok', hash, vault: row } : { state: 'denied' };
}

async function vaultBytes(db, vault) {
  const q = async (sql) => (await db.prepare(sql).bind(vault).first())?.n ?? 0;
  return (
    (await q('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM batches WHERE vault = ?')) +
    (await q('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM snapshot_parts WHERE vault = ?')) +
    (await q('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM blob_parts WHERE vault = ?'))
  );
}
async function addBytes(db, vault, n) {
  await db.prepare('UPDATE vaults SET bytes = MAX(0, bytes + ?) WHERE id = ?').bind(n, vault).run();
}
async function recount(db, vault) {
  await db.prepare('UPDATE vaults SET bytes = ? WHERE id = ?').bind(await vaultBytes(db, vault), vault).run();
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
const validData = (d) => typeof d === 'string' && d.length > 0 && d.length <= MAX_PART && /^[A-Za-z0-9+/=]+$/.test(d);

export async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (url.pathname === '/v1/health') return json({ ok: true, app: 'focus-sync-relay', version: 2, licenceRequired: !!env.LICENCE_SECRET });
  if (!env.DB) return json({ error: 'The relay has no database: bind a D1 database as DB (see README)' }, 500);
  const db = env.DB;
  const cfg = config(env);
  await ensureSchema(db);

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (!(await allow(db, `ip:${ip}`, 60, cfg.ipRate))) return json({ error: 'Too many requests; try again in a minute' }, 429, { 'Retry-After': '60' });

  const m = url.pathname.match(/^\/v1\/vaults\/([0-9a-f]{32})\/(.+)$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const [, vaultId, rest] = m;
  const auth = await authorise(db, vaultId, request);
  if (auth.state === 'denied') return json({ error: 'Wrong sync key' }, 403);
  if (!(await allow(db, `vault:${vaultId}`, 60, cfg.vaultRate))) return json({ error: 'Too many requests for this vault; try again in a minute' }, 429, { 'Retry-After': '60' });

  const isWrite = request.method === 'POST';
  const nowIso = new Date().toISOString();

  // Licence: refresh the stored expiry when a valid (newer) licence is presented.
  const licenceHeader = request.headers.get('X-Focus-Licence');
  let licence = null;
  if (cfg.licenceSecret && licenceHeader) licence = await verifyLicence(cfg.licenceSecret, licenceHeader);
  if (auth.state === 'ok' && licence && auth.vault.licence_id === licence.id) {
    const cur = auth.vault.licence_expires ?? 0;
    if ((licence.expires === 0 && cur !== 0) || licence.expires > cur) {
      await db.prepare('UPDATE vaults SET licence_expires = ? WHERE id = ?').bind(licence.expires, vaultId).run();
      auth.vault.licence_expires = licence.expires;
    }
  }
  const licenceOk = (v) => !cfg.licenceSecret || v.licence_expires === 0 || (v.licence_expires ?? 0) > now();

  // Creating a vault happens on its first upload.
  async function create() {
    if (!(await allow(db, `create:${ip}`, DAY, cfg.vaultsPerIp))) return json({ error: 'Too many new sync set-ups from this network today' }, 429, { 'Retry-After': '3600' });
    if (cfg.licenceSecret) {
      if (!licence) return json({ error: 'This relay needs a sync licence', code: 'licence_required' }, 402);
      if (licence.expires !== 0 && licence.expires <= now()) return json({ error: 'This sync licence has expired', code: 'licence_expired' }, 402);
      const used = await db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE licence_id = ?').bind(licence.id).first();
      if (used && used.n >= cfg.vaultsPerLicence) return json({ error: 'This licence has been used for too many sync set-ups', code: 'licence_used' }, 402);
    }
    await db
      .prepare('INSERT OR IGNORE INTO vaults (id, auth_hash, created_at, bytes, licence_id, licence_expires) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(vaultId, auth.hash, nowIso, licence?.id ?? null, licence?.expires ?? null)
      .run();
    const again = await authorise(db, vaultId, request);
    if (again.state !== 'ok') return json({ error: 'Wrong sync key' }, 403);
    auth.state = 'ok';
    auth.vault = again.vault;
    return null;
  }

  async function beforeWrite(size) {
    if (auth.state === 'new') {
      const err = await create();
      if (err) return err;
    }
    if (!licenceOk(auth.vault)) return json({ error: 'Your sync licence has expired; syncing new changes is paused (your data is still readable)', code: 'licence_expired' }, 402);
    if ((auth.vault.bytes ?? 0) + size > cfg.quota) return json({ error: 'Sync storage for this vault is full', code: 'quota', quota: cfg.quota, bytes: auth.vault.bytes }, 507);
    return null;
  }

  const empty = auth.state === 'new';
  let p;

  // ----- batches -----
  if (rest === 'batches' && request.method === 'GET') {
    if (empty) return json({ batches: [], more: false, snapshot: null });
    const after = Math.max(0, num(url.searchParams.get('after'), 0));
    const limit = Math.min(200, Math.max(1, num(url.searchParams.get('limit'), 100)));
    const snap = await db.prepare('SELECT id, up_to, parts FROM snapshots WHERE vault = ? AND complete = 1 ORDER BY up_to DESC LIMIT 1').bind(vaultId).first();
    // A device that is behind the latest snapshot must load it first: older batches are gone.
    if (snap && after < snap.up_to) return json({ batches: [], more: true, snapshot: { id: snap.id, upTo: snap.up_to, parts: snap.parts } });
    const { results } = await db.prepare('SELECT seq, device, data FROM batches WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?').bind(vaultId, after, limit + 1).all();
    return json({ batches: results.slice(0, limit), more: results.length > limit, snapshot: null });
  }
  if (rest === 'batches' && isWrite) {
    const body = await readBody(request);
    if (!body) return json({ error: 'Body must be JSON' }, 400);
    if (typeof body.device !== 'string' || !/^[0-9a-z-]{1,64}$/.test(body.device)) return json({ error: 'Bad device id' }, 400);
    if (!validData(body.data)) return json({ error: 'Bad or oversized data' }, 400);
    const err = await beforeWrite(body.data.length);
    if (err) return err;
    const r = await db.prepare('INSERT INTO batches (vault, device, data, created_at, size) VALUES (?, ?, ?, ?, ?)').bind(vaultId, body.device, body.data, nowIso, body.data.length).run();
    await addBytes(db, vaultId, body.data.length);
    return json({ seq: r.meta.last_row_id }, 201);
  }

  // ----- snapshots (compaction) -----
  if ((p = rest.match(/^snapshots\/([0-9a-z-]{8,64})\/parts\/(\d{1,3})$/))) {
    const [, sid, partStr] = p;
    const part = Number(partStr);
    if (request.method === 'GET') {
      const row = await db.prepare('SELECT data FROM snapshot_parts WHERE vault = ? AND id = ? AND part = ?').bind(vaultId, sid, part).first();
      return row ? json({ data: row.data }) : json({ error: 'Not found' }, 404);
    }
    if (isWrite) {
      const body = await readBody(request);
      if (!body || !validData(body.data)) return json({ error: 'Bad or oversized data' }, 400);
      const parts = num(body.parts, 0);
      const upTo = num(body.upTo, -1);
      if (parts < 1 || parts > MAX_PARTS || part >= parts || upTo < 0) return json({ error: 'Bad snapshot part' }, 400);
      const err = await beforeWrite(body.data.length);
      if (err) return err;
      const maxSeq = (await db.prepare('SELECT MAX(seq) AS n FROM batches WHERE vault = ?').bind(vaultId).first())?.n ?? 0;
      if (upTo > maxSeq) return json({ error: 'Snapshot is ahead of the stored batches' }, 409);
      await db.prepare('INSERT OR IGNORE INTO snapshots (vault, id, up_to, parts, complete, created_at) VALUES (?, ?, ?, ?, 0, ?)').bind(vaultId, sid, upTo, parts, nowIso).run();
      await db.prepare('INSERT OR REPLACE INTO snapshot_parts (vault, id, part, data) VALUES (?, ?, ?, ?)').bind(vaultId, sid, part, body.data).run();
      await addBytes(db, vaultId, body.data.length);
      const have = await db.prepare('SELECT COUNT(*) AS n FROM snapshot_parts WHERE vault = ? AND id = ?').bind(vaultId, sid).first();
      const snap = await db.prepare('SELECT up_to, parts FROM snapshots WHERE vault = ? AND id = ?').bind(vaultId, sid).first();
      if (have.n >= snap.parts) {
        // Complete: it replaces older snapshots and every batch it covers.
        await db.prepare('UPDATE snapshots SET complete = 1 WHERE vault = ? AND id = ?').bind(vaultId, sid).run();
        await db.prepare('DELETE FROM batches WHERE vault = ? AND seq <= ?').bind(vaultId, snap.up_to).run();
        await db.prepare('DELETE FROM snapshot_parts WHERE vault = ? AND id IN (SELECT id FROM snapshots WHERE vault = ? AND id <> ?)').bind(vaultId, vaultId, sid).run();
        await db.prepare('DELETE FROM snapshots WHERE vault = ? AND id <> ?').bind(vaultId, sid).run();
        await recount(db, vaultId);
        return json({ complete: true, upTo: snap.up_to }, 201);
      }
      return json({ complete: false }, 201);
    }
  }

  // ----- attachment files -----
  if ((p = rest.match(/^blobs\/([0-9a-z-]{8,80})(?:\/parts\/(\d{1,3})|\/delete)?$/))) {
    const [, bid, partStr] = p;
    if (rest.endsWith('/delete') && isWrite) {
      if (empty) return json({ deleted: true });
      await db.prepare('DELETE FROM blob_parts WHERE vault = ? AND id = ?').bind(vaultId, bid).run();
      await db.prepare('DELETE FROM blobs WHERE vault = ? AND id = ?').bind(vaultId, bid).run();
      await recount(db, vaultId);
      return json({ deleted: true });
    }
    if (partStr === undefined && request.method === 'GET') {
      if (empty) return json({ blob: null });
      const row = await db.prepare('SELECT parts, complete FROM blobs WHERE vault = ? AND id = ?').bind(vaultId, bid).first();
      return json({ blob: row ? { parts: row.parts, complete: row.complete === 1 } : null });
    }
    if (partStr !== undefined) {
      const part = Number(partStr);
      if (request.method === 'GET') {
        const row = await db.prepare('SELECT data FROM blob_parts WHERE vault = ? AND id = ? AND part = ?').bind(vaultId, bid, part).first();
        return row ? json({ data: row.data }) : json({ error: 'Not found' }, 404);
      }
      if (isWrite) {
        const body = await readBody(request);
        if (!body || !validData(body.data)) return json({ error: 'Bad or oversized data' }, 400);
        const parts = num(body.parts, 0);
        if (parts < 1 || parts > MAX_PARTS || part >= parts) return json({ error: 'Bad part number' }, 400);
        const err = await beforeWrite(body.data.length);
        if (err) return err;
        await db.prepare('INSERT OR IGNORE INTO blobs (vault, id, parts, complete, created_at) VALUES (?, ?, ?, 0, ?)').bind(vaultId, bid, parts, nowIso).run();
        await db.prepare('INSERT OR REPLACE INTO blob_parts (vault, id, part, data) VALUES (?, ?, ?, ?)').bind(vaultId, bid, part, body.data).run();
        await addBytes(db, vaultId, body.data.length);
        const have = await db.prepare('SELECT COUNT(*) AS n FROM blob_parts WHERE vault = ? AND id = ?').bind(vaultId, bid).first();
        const complete = have.n >= parts;
        if (complete) await db.prepare('UPDATE blobs SET complete = 1 WHERE vault = ? AND id = ?').bind(vaultId, bid).run();
        return json({ complete }, 201);
      }
    }
  }

  // ----- usage -----
  if (rest === 'usage' && request.method === 'GET') {
    if (empty) return json({ bytes: 0, quota: cfg.quota, batches: 0, licenceExpires: null });
    const n = await db.prepare('SELECT COUNT(*) AS n FROM batches WHERE vault = ?').bind(vaultId).first();
    return json({ bytes: auth.vault.bytes ?? 0, quota: cfg.quota, batches: n?.n ?? 0, licenceExpires: auth.vault.licence_expires ?? null });
  }

  // ----- erase -----
  if (rest === 'delete' && isWrite) {
    if (empty) return json({ deleted: true });
    for (const t of ['batches', 'snapshot_parts', 'snapshots', 'blob_parts', 'blobs']) await db.prepare(`DELETE FROM ${t} WHERE vault = ?`).bind(vaultId).run();
    await db.prepare('DELETE FROM vaults WHERE id = ?').bind(vaultId).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
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
