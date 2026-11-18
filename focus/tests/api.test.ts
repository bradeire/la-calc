import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

const NOW = new Date(2026, 10, 16, 9, 0);
type Body = Record<string, unknown> & { tasks?: { title: string; id: string }[]; task?: Record<string, unknown> & { id: string }; error?: string };

async function setup() {
  const { app } = await makeApp(NOW);
  const call = (method: string, path: string, body?: unknown, approved: string[] = []) => {
    const [p, query = ''] = path.split('?');
    const r = app.api.handle({ method, path: p!, query, body: body === undefined ? '' : JSON.stringify(body) }, approved);
    return { status: r.status, body: r.body as Body };
  };
  return { app, call };
}

describe('local API', () => {
  it('creates tasks from natural language or fields, lists, edits and completes them', async () => {
    const { app, call } = await setup();
    const home = app.projects.create({ name: 'Home' });
    const a = call('POST', '/v1/tasks', { text: 'Phone dentist tomorrow 10am #Home p2 @calls' });
    expect(a.status).toBe(201);
    // "#Home" in text is only a suggestion: imported tasks go to the Inbox for the user to file.
    expect(a.body.task).toMatchObject({ title: 'Phone dentist', project: null, priority: 2, scheduledDate: '2026-11-17', scheduledTime: '10:00', labels: ['calls'] });
    expect(a.body.task!.description).toContain('Suggested project: Home');
    const b = call('POST', '/v1/tasks', { title: 'Buy paint', project: 'home', deadline: '2026-11-30', labels: ['diy'] });
    expect(b.body.task).toMatchObject({ projectId: home.id, deadline: '2026-11-30', labels: ['diy'] });

    expect(call('GET', '/v1/tasks').body.tasks!.map((t) => t.title).sort()).toEqual(['Buy paint', 'Phone dentist']);
    expect(call('GET', '/v1/tasks?filter=' + encodeURIComponent('@calls')).body.tasks!.map((t) => t.title)).toEqual(['Phone dentist']);

    const id = b.body.task!.id;
    expect(call('PATCH', `/v1/tasks/${id}`, { priority: 1, scheduledDate: '2026-11-20' }).body.task).toMatchObject({ priority: 1, scheduledDate: '2026-11-20' });
    expect(call('POST', `/v1/tasks/${id}/complete`).body.task).toMatchObject({ status: 'completed' });
    expect(call('GET', '/v1/tasks?status=completed').body.tasks!.map((t) => t.title)).toEqual(['Buy paint']);
    expect(call('POST', `/v1/tasks/${id}/reopen`).body.task!.status).not.toBe('completed');
  });

  it('validates input and never deletes', async () => {
    const { call } = await setup();
    expect(call('POST', '/v1/tasks', {}).status).toBe(400);
    expect(call('POST', '/v1/tasks', { title: 'x', text: 'y' }).status).toBe(400);
    expect(call('POST', '/v1/tasks', { title: 'x', scheduledDate: '20/11/2026' }).body.error).toMatch(/YYYY-MM-DD/);
    expect(call('POST', '/v1/tasks', { title: 'x', unknown: 1 }).status).toBe(400);
    expect(call('POST', '/v1/tasks', { title: 'x', project: 'Nope' }).body.error).toMatch(/No project/);
    expect(call('PATCH', '/v1/tasks/00000000-0000-4000-8000-000000000000', { title: 'y' }).status).toBe(404);
    expect(call('PATCH', '/v1/tasks/x', { status: 'completed' }).status).toBe(404);
    expect(call('GET', '/v1/tasks?filter=' + encodeURIComponent('(((')).status).toBe(400);
    expect(call('DELETE', '/v1/tasks/x').status).toBe(404);
    expect(call('GET', '/v1/nothing').status).toBe(404);
    const bad = call('POST', '/v1/tasks', undefined);
    expect(bad.status).toBe(400);
  });

  it('asks for force when completing a blocked task', async () => {
    const { app, call } = await setup();
    const a = app.tasks.create({ title: 'Get quotes' });
    const b = app.tasks.create({ title: 'Choose fitter' });
    app.tasks.addDependency(b.id, a.id);
    expect(call('POST', `/v1/tasks/${b.id}/complete`).status).toBe(409);
    expect(call('POST', `/v1/tasks/${b.id}/complete?force=true`).status).toBe(200);
  });

  it('lists and creates projects, lists labels', async () => {
    const { app, call } = await setup();
    app.labels.create({ name: 'errands' });
    const p = call('POST', '/v1/projects', { name: 'Garden' });
    expect(p.status).toBe(201);
    expect((call('GET', '/v1/projects').body.projects as { name: string }[]).map((x) => x.name)).toContain('Garden');
    expect((call('GET', '/v1/labels').body.labels as { name: string }[]).map((x) => x.name)).toEqual(['errands']);
  });

  it('runs only automations the user approved for the API', async () => {
    const { app, call } = await setup();
    const id = app.automations.save({ name: 'Make urgent', trigger: { type: 'task.created' }, actions: [{ type: 'setPriority', priority: 1 }] });
    const t = app.tasks.create({ title: 'Later' });
    // The automation ran on creation already; reset and run it on request.
    app.tasks.update(t.id, { priority: 4 });
    expect(call('GET', '/v1/automations').body.automations).toEqual([]);
    expect(call('POST', `/v1/automations/${id}/run`, { taskId: t.id }).status).toBe(403);
    expect(call('GET', '/v1/automations', undefined, [id]).body.automations).toEqual([{ id, name: 'Make urgent', trigger: 'task.created' }]);
    expect(call('POST', `/v1/automations/${id}/run`, { taskId: t.id }, [id])).toMatchObject({ status: 200, body: { ran: true } });
    expect(app.repos.tasks.get(t.id)!.priority).toBe(1);
    expect(call('POST', `/v1/automations/${id}/run`, {}, [id]).status).toBe(400);
  });
});
