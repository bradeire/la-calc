import { describe, expect, it } from 'vitest';
import { deriveSyncKeys, generateSyncKey, openJson, parseSyncKey, sealJson } from '@/core/sync/crypto';
import { makeApp } from './helpers';
import { fakeRelay } from './relay';

const RELAY = 'https://relay.example.workers.dev';
const tick = () => new Promise((r) => setTimeout(r, 5));

async function pair() {
  const relay = await fakeRelay();
  const a = await makeApp();
  const b = await makeApp();
  a.platform.http.handler = relay.http;
  b.platform.http.handler = relay.http;
  return { relay, a: a.app, b: b.app, pa: a.platform, pb: b.platform };
}

describe('sync crypto', () => {
  it('derives separate ids and round-trips encrypted data', async () => {
    const key = generateSyncKey();
    expect(key).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(parseSyncKey(key.toLowerCase().replace(/-/g, ' '))).toHaveLength(32);
    expect(() => parseSyncKey('ABCD-EFGH')).toThrow(/incomplete/);
    const k = await deriveSyncKeys(key);
    expect(k.vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect(k.token).toMatch(/^[0-9a-f]{64}$/);
    const sealed = await sealJson(k, [{ title: 'Secret plans' }]);
    expect(atob(sealed)).not.toContain('Secret');
    expect(await openJson(k, sealed)).toEqual([{ title: 'Secret plans' }]);
    await expect(openJson(await deriveSyncKeys(generateSyncKey()), sealed)).rejects.toThrow(/decrypted/);
  });
});

describe('sync between two devices', () => {
  it('a task added on one device appears on the other; the relay only holds ciphertext', async () => {
    const { relay, a, b } = await pair();
    const home = a.projects.create({ name: 'Home' });
    const label = a.labels.create({ name: 'errands' });
    a.tasks.create({ title: 'Buy lightbulbs', projectId: home.id, labelIds: [label.id], scheduledDate: '2026-11-20', description: 'Kitchen ones' });
    a.projects.update(home.id, { notes: 'Boiler serviced in March' });
    const { key } = await a.sync.enable({ relayUrl: RELAY });

    await b.sync.enable({ relayUrl: RELAY, key });
    const t = b.repos.tasks.listForReports().find((x) => x.title === 'Buy lightbulbs')!;
    expect(t).toMatchObject({ scheduledDate: '2026-11-20', description: 'Kitchen ones' });
    expect(b.repos.projects.get(t.projectId!)!.notes).toBe('Boiler serviced in March');
    expect(b.repos.labels.get(t.labelIds[0]!)!.name).toBe('errands');

    // Nothing readable on the relay.
    const stored = relay.db.exec('SELECT data FROM batches')[0]!.values.map((r) => String(r[0])).join('');
    expect(stored).not.toMatch(/lightbulbs|Boiler|errands/);
    expect(relay.db.exec('SELECT auth_hash FROM vaults')[0]!.values[0]![0]).not.toBe((await deriveSyncKeys(key)).token);

    // And back: B completes it, A sees that.
    b.tasks.complete(t.id);
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.repos.tasks.get(t.id)!.status).toBe('completed');
    expect(a.sync.status()).toMatchObject({ enabled: true, pending: 0, lastError: null });
  });

  it('merges both devices’ existing data when the second one joins', async () => {
    const { a, b } = await pair();
    a.tasks.create({ title: 'From desktop' });
    b.tasks.create({ title: 'From phone' });
    const { key } = await a.sync.enable({ relayUrl: RELAY });
    await b.sync.enable({ relayUrl: RELAY, key });
    await a.sync.syncNow();
    const titles = (app: typeof a) => app.repos.tasks.listForReports().map((t) => t.title).sort();
    expect(titles(a)).toEqual(['From desktop', 'From phone']);
    expect(titles(b)).toEqual(['From desktop', 'From phone']);
  });

  it('later edit wins, deletions and trash sync, and nothing echoes back', async () => {
    const { relay, a, b } = await pair();
    const t = a.tasks.create({ title: 'Original' });
    const gone = a.tasks.create({ title: 'To delete' });
    const { key } = await a.sync.enable({ relayUrl: RELAY });
    await b.sync.enable({ relayUrl: RELAY, key });

    // Both edit offline; B's edit is later.
    a.tasks.update(t.id, { title: 'Edited on A', priority: 2 });
    await tick();
    b.tasks.update(t.id, { title: 'Edited on B' });
    a.tasks.remove([gone.id]);
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.repos.tasks.get(t.id)!.title).toBe('Edited on B');
    expect(b.repos.tasks.get(t.id)!.title).toBe('Edited on B');
    expect(b.repos.tasks.get(gone.id)!.deletedAt).not.toBeNull();

    // Purging from Trash (a real delete) syncs too.
    a.tasks.purge(gone.id);
    expect(a.repos.tasks.get(gone.id)).toBeUndefined();
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.repos.tasks.get(gone.id)).toBeUndefined();

    // Applying remote changes queues nothing to send back.
    expect(a.sync.status().pending).toBe(0);
    const before = relay.requests.filter((r) => r.method === 'POST').length;
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(relay.requests.filter((r) => r.method === 'POST').length).toBe(before);
  });

  it('settles same-named labels the same way on both devices', async () => {
    const { a, b } = await pair();
    a.labels.create({ name: 'garden' });
    b.labels.create({ name: 'garden' });
    const { key } = await a.sync.enable({ relayUrl: RELAY });
    await b.sync.enable({ relayUrl: RELAY, key });
    await a.sync.syncNow();
    const names = (app: typeof a) => app.repos.labels.list().map((l) => `${l.id}:${l.name}`).sort();
    expect(names(a)).toEqual(names(b));
    expect(a.repos.labels.list().map((l) => l.name).filter((n) => n === 'garden')).toHaveLength(1);
  });

  it('syncs shared preferences but not device ones, and survives being offline', async () => {
    const { relay, a, b } = await pair();
    const { key } = await a.sync.enable({ relayUrl: RELAY });
    await b.sync.enable({ relayUrl: RELAY, key });
    a.repos.settings.set('weekStartsOn', 0);
    a.repos.settings.set('theme', 'dark');
    relay.setOffline(true);
    a.tasks.create({ title: 'Written offline' });
    await expect(a.sync.syncNow()).rejects.toThrow(/Couldn’t reach/);
    expect(a.sync.status().lastError).toMatch(/Couldn’t reach/);
    relay.setOffline(false);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.repos.settings.getAll().weekStartsOn).toBe(0);
    expect(b.repos.settings.getAll().theme).toBe('system');
    expect(b.repos.tasks.listForReports().map((t) => t.title)).toContain('Written offline');
  });

  it('refuses a wrong key and a key nobody has used yet', async () => {
    const { a, b } = await pair();
    await a.sync.enable({ relayUrl: RELAY });
    await expect(b.sync.enable({ relayUrl: RELAY, key: generateSyncKey() })).rejects.toThrow(/Nothing has been synced/);
    await expect(b.sync.enable({ relayUrl: RELAY, key: 'not a key' })).rejects.toThrow();
    await expect(b.sync.enable({ relayUrl: 'http://example.com', key: generateSyncKey() })).rejects.toThrow(/https/);
    expect(b.sync.status().enabled).toBe(false);
  });

  it('a child that arrives before its parent waits instead of breaking sync', async () => {
    const { a, b } = await pair();
    const { key } = await a.sync.enable({ relayUrl: RELAY });
    await b.sync.enable({ relayUrl: RELAY, key });
    const p = a.projects.create({ name: 'Trip' });
    const task = a.tasks.create({ title: 'Pack', projectId: p.id });
    await a.sync.syncNow();
    void task;
    // Simulate receiving a task whose project hasn't arrived.
    b.sync.apply([
      { t: 'tasks', k: 'ffffffff-ffff-4fff-8fff-ffffffffffff', v: '9999-01-01T00:00:00.000Z|zz', r: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Orphan', project_id: '00000000-0000-4000-8000-000000000000', priority: 4, status: 'active', created_at: '2026-11-16T00:00:00.000Z', updated_at: '2026-11-16T00:00:00.000Z', sort_order: 0 } },
    ]);
    expect(b.sync.status().waiting).toBe(1);
    await b.sync.syncNow();
    expect(b.repos.tasks.listForReports().map((t) => t.title)).toContain('Pack');
  });

  it('disabling forgets the key and stops capturing changes', async () => {
    const { a, pa } = await pair();
    await a.sync.enable({ relayUrl: RELAY });
    await a.sync.disable();
    expect(await pa.secrets.get('sync:key')).toBeNull();
    a.tasks.create({ title: 'After' });
    expect(a.sync.status()).toMatchObject({ enabled: false, pending: 0 });
  });
});
