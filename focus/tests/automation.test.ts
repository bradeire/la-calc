import { describe, expect, it } from 'vitest';
import { parseQuery } from '@/core/filters/query';
import { makeApp } from './helpers';

describe('automation engine', () => {
  it('task.created with conditions → actions (add label, set priority)', async () => {
    const { app } = await makeApp();
    const home = app.projects.create({ name: 'Home' });
    const urgent = app.labels.create({ name: 'urgent' });
    const cond = parseQuery('#Home', { projects: [{ id: home.id, name: 'Home' }], labels: [] }).definition;
    app.automations.save({
      name: 'Home tasks are urgent',
      trigger: { type: 'task.created' },
      conditions: cond,
      actions: [{ type: 'addLabel', labelId: urgent.id }, { type: 'setPriority', priority: 2 }],
    });
    const t = app.tasks.create({ title: 'Fix boiler', projectId: home.id });
    const other = app.tasks.create({ title: 'Elsewhere' });
    expect(app.repos.tasks.get(t.id)).toMatchObject({ priority: 2, labelIds: [urgent.id] });
    expect(app.repos.tasks.get(other.id)).toMatchObject({ priority: 4, labelIds: [] });
    expect(app.automations.runs()[0]).toMatchObject({ status: 'succeeded' });
  });

  it('overdue sweep notifies once per task (duplicate prevention)', async () => {
    const { app } = await makeApp(new Date(2026, 10, 16, 9));
    const notes: string[] = [];
    app.automations.setNotifier((_t, body) => notes.push(body));
    app.automations.save({ name: 'Overdue', trigger: { type: 'task.overdue' }, actions: [{ type: 'notify', message: '{{task.title}} is overdue' }] });
    app.tasks.create({ title: 'Old', scheduledDate: '2026-11-10' });
    app.tasks.create({ title: 'Future', scheduledDate: '2026-11-20' });
    expect(app.automations.sweep()).toBe(1);
    expect(app.automations.sweep()).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(notes).toEqual(['Old is overdue']);
  });

  it('waiting more than three days → follow-up task', async () => {
    const now = { t: new Date(2026, 10, 16, 9) };
    const { app } = await makeApp(now.t);
    const t = app.tasks.create({ title: 'Quote from plumber' });
    app.tasks.setStatus(t.id, 'waiting');
    // Backdate the status change by four days.
    app.repos.db.run("UPDATE activity_log SET created_at = ? WHERE entity_id = ? AND action = 'updated'", [new Date(now.t.getTime() - 4 * 86400000).toISOString(), t.id]);
    app.automations.save({ name: 'Chase', trigger: { type: 'task.waitingTooLong', days: 3 }, actions: [{ type: 'createTask', title: 'Follow up: {{task.title}}', scheduleInDays: 0, sameProject: true }] });
    expect(app.automations.sweep()).toBe(1);
    expect(app.repos.tasks.listInbox().map((x) => x.title)).toContain('Follow up: Quote from plumber');
  });

  it('project completed → archive project', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Move house' });
    const a = app.tasks.create({ title: 'Pack', projectId: p.id });
    const b = app.tasks.create({ title: 'Clean', projectId: p.id });
    app.automations.save({ name: 'Archive finished projects', trigger: { type: 'project.completed' }, actions: [{ type: 'archiveProject' }] });
    app.tasks.complete(a.id);
    expect(app.repos.projects.get(p.id)!.archivedAt).toBeNull();
    app.tasks.complete(b.id);
    expect(app.repos.projects.get(p.id)!.archivedAt).toBeTruthy();
  });

  it('project created with matching name → apply template', async () => {
    const { app } = await makeApp();
    app.automations.save({ name: 'Trips', trigger: { type: 'project.created', nameContains: 'trip' }, actions: [{ type: 'applyTemplate', templateId: 'builtin:holiday' }] });
    const p = app.projects.create({ name: 'Paris trip' });
    const q = app.projects.create({ name: 'Garden' });
    expect(app.repos.tasks.listByProject(p.id).map((t) => t.title)).toContain('Book accommodation');
    expect(app.repos.tasks.listByProject(q.id)).toHaveLength(0);
  });

  it('prevents loops and records them', async () => {
    const { app } = await makeApp();
    // Creating a task creates a task… would loop forever without protection.
    app.automations.save({ name: 'Echo', trigger: { type: 'task.created' }, actions: [{ type: 'createTask', title: 'Echo of {{task.title}}' }] });
    app.tasks.create({ title: 'Start' });
    expect(app.repos.tasks.listInbox().map((t) => t.title).sort()).toEqual(['Echo of Start', 'Start']);
    expect(app.automations.runs().some((r) => r.status === 'skipped' && /loop/.test(r.error ?? ''))).toBe(true);
  });

  it('enforces the hourly limit', async () => {
    const { app } = await makeApp();
    app.automations.save({ name: 'Tag', trigger: { type: 'task.created' }, actions: [{ type: 'setPriority', priority: 3 }], maxRunsPerHour: 2 });
    for (let i = 0; i < 3; i++) app.tasks.create({ title: `t${i}` });
    const runs = app.automations.runs();
    expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    expect(runs.some((r) => r.status === 'skipped' && /limit/.test(r.error ?? ''))).toBe(true);
  });

  it('failed actions roll back and are logged', async () => {
    const { app } = await makeApp();
    const l = app.labels.create({ name: 'temp' });
    app.automations.save({ name: 'Broken', trigger: { type: 'task.created' }, actions: [{ type: 'setPriority', priority: 1 }, { type: 'addLabel', labelId: l.id }] });
    app.repos.labels.update(l.id, { deletedAt: new Date().toISOString() }); // label vanishes after saving
    const t = app.tasks.create({ title: 'x' });
    expect(app.repos.tasks.get(t.id)!.priority).toBe(4); // first action rolled back
    expect(app.automations.runs()[0]).toMatchObject({ status: 'failed' });
    expect(app.automations.runs()[0]!.error).toMatch(/no longer exists/);
  });

  it('disabled automations do nothing; test mode changes nothing', async () => {
    const { app } = await makeApp();
    const id = app.automations.save({ name: 'P1', enabled: false, trigger: { type: 'task.created' }, actions: [{ type: 'setPriority', priority: 1 }] });
    const t = app.tasks.create({ title: 'x' });
    expect(app.repos.tasks.get(t.id)!.priority).toBe(4);
    const result = app.automations.test({ name: 'P1', trigger: { type: 'task.created' }, actions: [{ type: 'setPriority', priority: 1 }] }, { taskId: t.id });
    expect(result).toEqual({ matches: true, reason: 'Trigger and conditions matched', actions: ['Set priority to P1'] });
    expect(app.repos.tasks.get(t.id)!.priority).toBe(4);
    app.automations.setEnabled(id, true);
    app.tasks.create({ title: 'y' });
    expect(app.repos.tasks.listInbox().find((x) => x.title === 'y')!.priority).toBe(1);
  });

  it('rejects invalid definitions', async () => {
    const { app } = await makeApp();
    expect(() => app.automations.save({ name: '', trigger: { type: 'task.created' }, actions: [] })).toThrow();
    expect(() => app.automations.save({ name: 'x', trigger: { type: 'task.created' }, actions: [{ type: 'addLabel', labelId: 'missing' }] })).toThrow(/no longer exists/);
  });
});

describe('webhooks', () => {
  it('signs payloads with HMAC-SHA256 and sends minimal task data', async () => {
    const { app, platform } = await makeApp();
    const id = await app.webhooks.save({ name: 'Home Assistant', url: 'http://ha.local:8123/api/webhook/focus', secret: 's3cret' });
    app.automations.save({ name: 'HA on complete', trigger: { type: 'task.completed' }, actions: [{ type: 'webhook', webhookId: id }] });
    const t = app.tasks.create({ title: 'Replace filter', description: 'private notes' });
    app.tasks.complete(t.id);
    await new Promise((r) => setTimeout(r, 20));
    const req = platform.http.requests[0]!;
    expect(req.url).toBe('http://ha.local:8123/api/webhook/focus');
    const body = JSON.parse(req.body!);
    expect(body).toMatchObject({ event: 'task.completed', task: { title: 'Replace filter', status: 'completed' } });
    expect(req.body).not.toContain('private notes');
    // Verify the signature independently.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(req.body!)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(req.headers!['X-Focus-Signature']).toBe(`sha256=${sig}`);
  });

  it('records webhook failures on the run', async () => {
    const { app, platform } = await makeApp();
    platform.http.handler = () => ({ status: 500, body: 'boom' });
    const id = await app.webhooks.save({ name: 'Bad', url: 'https://example.invalid/hook' });
    app.automations.save({ name: 'Call', trigger: { type: 'task.created' }, actions: [{ type: 'webhook', webhookId: id }] });
    app.tasks.create({ title: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(app.automations.runs()[0]).toMatchObject({ status: 'failed' });
    expect(app.automations.runs()[0]!.error).toMatch(/answered 500/);
  });

  it('validates URLs and never stores secrets in the database', async () => {
    const { app, db } = await makeApp();
    await expect(app.webhooks.save({ name: 'x', url: 'not a url' })).rejects.toThrow();
    await app.webhooks.save({ name: 'ok', url: 'https://example.com/h', secret: 'TOPSECRET' });
    expect(JSON.stringify(db.all('SELECT * FROM integrations'))).not.toContain('TOPSECRET');
  });
});
