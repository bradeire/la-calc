import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '@/core/nlp/parser';
import { ValidationError } from '@/services/events';
import { makeApp } from './helpers';

describe('task lifecycle', () => {
  it('creates, edits, completes, reopens and logs activity', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Write report', priority: 2 });
    expect(t.status).toBe('inbox');
    app.tasks.update(t.id, { title: 'Write Q4 report', scheduledDate: '2026-11-16', scheduledTime: '09:30' });
    app.tasks.complete(t.id);
    expect(app.repos.tasks.get(t.id)!.status).toBe('completed');
    expect(app.repos.tasks.get(t.id)!.completedAt).toBeTruthy();
    app.tasks.reopen(t.id);
    expect(app.repos.tasks.get(t.id)!.status).toBe('inbox');
    const actions = app.repos.activity.listFor(t.id).map((a) => a.action);
    expect(actions).toEqual(['reopened', 'completed', 'updated', 'created']);
  });

  it('validates input with clear errors', async () => {
    const { app } = await makeApp();
    expect(() => app.tasks.create({ title: '   ' })).toThrow(ValidationError);
    expect(() => app.tasks.create({ title: 'x', scheduledDate: '14/11/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => app.tasks.create({ title: 'x', projectId: crypto.randomUUID() })).toThrow(/project no longer exists/);
  });

  it('clears the time when the date is removed', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'x', scheduledDate: '2026-11-14', scheduledTime: '10:00' });
    expect(app.tasks.update(t.id, { scheduledDate: null }).scheduledTime).toBeNull();
  });

  it('keeps scheduled date and deadline independent', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'x', scheduledDate: '2026-11-20', deadline: '2026-11-25' });
    const u = app.tasks.update(t.id, { scheduledDate: '2026-11-21' });
    expect(u.deadline).toBe('2026-11-25');
  });

  it('undo completion restores the previous status', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'P' });
    const t = app.tasks.create({ title: 'x', projectId: p.id, status: 'waiting' });
    const undo = app.tasks.complete(t.id);
    undo.undo();
    expect(app.repos.tasks.get(t.id)!.status).toBe('waiting');
  });

  it('soft delete, undo, trash, restore and purge', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Parent' });
    const c = app.tasks.create({ title: 'Child', parentId: t.id });
    const undo = app.tasks.remove([t.id]);
    expect(app.repos.tasks.listInbox()).toHaveLength(0);
    expect(app.repos.tasks.listTrash().map((x) => x.id)).toEqual([t.id]); // child hidden under parent
    undo.undo();
    expect(app.repos.tasks.listInbox()).toHaveLength(2);
    app.tasks.remove([t.id]);
    app.tasks.restore(t.id);
    expect(app.repos.tasks.get(c.id)!.deletedAt).toBeNull();
    expect(() => app.tasks.purge(t.id)).toThrow(/Only tasks in Trash/);
    app.tasks.remove([t.id]);
    app.tasks.purge(t.id);
    expect(app.repos.tasks.get(t.id)).toBeUndefined();
    expect(app.repos.tasks.get(c.id)).toBeUndefined();
  });

  it('duplicates with subtasks and labels', async () => {
    const { app } = await makeApp();
    const l = app.labels.create({ name: 'home' });
    const t = app.tasks.create({ title: 'Paint', labelIds: [l.id] });
    app.tasks.create({ title: 'Buy paint', parentId: t.id });
    const d = app.tasks.duplicate(t.id);
    expect(d.title).toBe('Paint (copy)');
    expect(d.labelIds).toEqual([l.id]);
    expect(app.repos.tasks.children(d.id).map((x) => x.title)).toEqual(['Buy paint']);
  });

  it('moving to a project sets status active and moves subtasks with it', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Home' });
    const s = app.projects.addSection(p.id, 'Garden');
    const t = app.tasks.create({ title: 'Mow' });
    const c = app.tasks.create({ title: 'Fuel', parentId: t.id });
    const undo = app.tasks.move([t.id], { projectId: p.id, sectionId: s });
    expect(app.repos.tasks.get(t.id)).toMatchObject({ projectId: p.id, sectionId: s, status: 'active' });
    expect(app.repos.tasks.get(c.id)).toMatchObject({ projectId: p.id, sectionId: s });
    undo.undo();
    expect(app.repos.tasks.get(t.id)).toMatchObject({ projectId: null, status: 'inbox' });
    expect(app.repos.tasks.get(c.id)!.projectId).toBeNull();
  });

  it('search finds titles, descriptions, comments, projects and labels, with prefixes and accents', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Garden' });
    const l = app.labels.create({ name: 'calls' });
    const a = app.tasks.create({ title: 'Book café table', description: 'For Saturday' });
    const b = app.tasks.create({ title: 'Prune roses', projectId: p.id });
    const c = app.tasks.create({ title: 'Ring council', labelIds: [l.id] });
    const d = app.tasks.create({ title: 'Something' });
    app.content.addComment(d.id, 'Remember the invoice number');
    const ids = (q: string) => app.repos.tasks.search(q).map((t) => t.id);
    expect(ids('cafe')).toEqual([a.id]);
    expect(ids('satur')).toEqual([a.id]);
    expect(ids('garden')).toEqual([b.id]);
    expect(ids('calls')).toEqual([c.id]);
    expect(ids('invoice')).toEqual([d.id]);
    expect(ids('"; DROP TABLE tasks; --')).toEqual([]);
  });
});

describe('subtasks', () => {
  it('nests to any depth, reports progress and prevents cycles', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'A' });
    const b = app.tasks.create({ title: 'B', parentId: a.id });
    const c = app.tasks.create({ title: 'C', parentId: b.id });
    app.tasks.create({ title: 'D', parentId: c.id });
    expect(app.repos.tasks.descendantIds(a.id)).toHaveLength(3);
    app.tasks.complete(c.id); // completes D as well
    expect(app.repos.tasks.progressFor([a.id]).get(a.id)).toEqual({ done: 2, total: 3 });
    expect(() => app.tasks.update(a.id, { parentId: c.id })).toThrow(/own subtasks/);
    expect(() => app.tasks.update(a.id, { parentId: a.id })).toThrow();
  });

  it('does not auto-complete the parent unless enabled', async () => {
    const { app } = await makeApp();
    const p = app.tasks.create({ title: 'P' });
    const c = app.tasks.create({ title: 'C', parentId: p.id });
    app.tasks.complete(c.id);
    expect(app.repos.tasks.get(p.id)!.status).toBe('inbox');

    app.repos.settings.set('autoCompleteParent', true);
    const p2 = app.tasks.create({ title: 'P2' });
    const c2 = app.tasks.create({ title: 'C2', parentId: p2.id });
    const undo = app.tasks.complete(c2.id);
    expect(app.repos.tasks.get(p2.id)!.status).toBe('completed');
    undo.undo();
    expect(app.repos.tasks.get(p2.id)!.status).toBe('inbox');
  });

  it('promotes a subtask to an independent task in the same project', async () => {
    const { app } = await makeApp();
    const proj = app.projects.create({ name: 'Work' });
    const p = app.tasks.create({ title: 'P', projectId: proj.id });
    const c = app.tasks.create({ title: 'C', parentId: p.id });
    expect(app.repos.tasks.get(c.id)!.projectId).toBe(proj.id); // inherits
    app.tasks.promote(c.id);
    expect(app.repos.tasks.get(c.id)).toMatchObject({ parentId: null, projectId: proj.id });
  });

  it('moves a subtask to another parent', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'A' });
    const b = app.tasks.create({ title: 'B' });
    const c = app.tasks.create({ title: 'C', parentId: a.id });
    app.tasks.update(c.id, { parentId: b.id });
    expect(app.repos.tasks.children(b.id).map((x) => x.id)).toEqual([c.id]);
  });
});

describe('recurring tasks', () => {
  it('completing creates exactly one next occurrence and keeps history', async () => {
    const { app } = await makeApp();
    const parsed = parseQuickAdd('Bins every tuesday', { now: new Date(2026, 10, 14, 10) });
    const t = app.quickAdd.commit(parsed);
    expect(t.scheduledDate).toBe('2026-11-17');
    app.tasks.complete(t.id);
    const open = app.repos.tasks.listInbox();
    expect(open).toHaveLength(1);
    expect(open[0]!.scheduledDate).toBe('2026-11-24');
    expect(open[0]!.seriesId).toBe(t.seriesId);
    expect(open[0]!.recurrence).toEqual(t.recurrence);
    expect(app.repos.tasks.get(t.id)!.status).toBe('completed');
  });

  it('never creates duplicate future instances', async () => {
    const { app } = await makeApp();
    const t = app.quickAdd.commit(parseQuickAdd('Water plants every day', { now: new Date(2026, 10, 14, 10) }));
    app.tasks.complete(t.id);
    // Reopen the old one and complete it again: the open next occurrence already exists.
    app.tasks.reopen(t.id);
    app.tasks.complete(t.id);
    const open = app.repos.tasks.listInbox().filter((x) => x.seriesId === t.seriesId);
    expect(open).toHaveLength(1);
  });

  it('overdue recurring task moves to the future', async () => {
    const { app } = await makeApp(new Date(2026, 10, 14, 10));
    const rule = { v: 1 as const, freq: 'daily' as const, interval: 1, basis: 'scheduled' as const, anchor: '2026-11-01' };
    const t = app.tasks.create({ title: 'Daily', scheduledDate: '2026-11-09', recurrence: rule, recurrenceText: 'Every day' });
    app.tasks.complete(t.id);
    expect(app.repos.tasks.listInbox()[0]!.scheduledDate).toBe('2026-11-15');
  });

  it('copies labels, subtasks (reopened) and shifts the deadline', async () => {
    const { app } = await makeApp();
    const l = app.labels.create({ name: 'home' });
    const rule = { v: 1 as const, freq: 'weekly' as const, interval: 1, basis: 'scheduled' as const, anchor: '2026-11-14' };
    const t = app.tasks.create({ title: 'Clean', scheduledDate: '2026-11-14', deadline: '2026-11-15', labelIds: [l.id], recurrence: rule });
    app.tasks.create({ title: 'Hoover', parentId: t.id });
    app.tasks.complete(t.id);
    const next = app.repos.tasks.listInbox().find((x) => x.parentId === null)!;
    expect(next).toMatchObject({ scheduledDate: '2026-11-21', deadline: '2026-11-22', labelIds: [l.id] });
    expect(app.repos.tasks.children(next.id).map((c) => [c.title, c.status])).toEqual([['Hoover', 'inbox']]);
  });

  it('undo removes the generated occurrence', async () => {
    const { app } = await makeApp();
    const t = app.quickAdd.commit(parseQuickAdd('Stretch every day', { now: new Date(2026, 10, 14, 10) }));
    const undo = app.tasks.complete(t.id);
    expect(app.repos.tasks.listInbox()).toHaveLength(1);
    undo.undo();
    const open = app.repos.tasks.listInbox();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(t.id);
  });
});

describe('views', () => {
  it('Today = overdue + today + deadlines due + pinned; excludes archived projects', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Archived soon' });
    app.tasks.create({ title: 'overdue', scheduledDate: '2026-11-10' });
    app.tasks.create({ title: 'today', scheduledDate: '2026-11-14' });
    app.tasks.create({ title: 'deadline', deadline: '2026-11-14' });
    app.tasks.create({ title: 'pinned', pinnedToday: true });
    app.tasks.create({ title: 'future', scheduledDate: '2026-11-20' });
    app.tasks.create({ title: 'hidden', projectId: p.id, scheduledDate: '2026-11-14' });
    app.projects.archive(p.id);
    expect(app.repos.tasks.listToday('2026-11-14').map((t) => t.title).sort()).toEqual(['deadline', 'overdue', 'pinned', 'today']);
    expect(app.repos.tasks.countOpen({ today: '2026-11-14' })).toBe(4);
  });

  it('Upcoming lists scheduled dates and deadlines in range', async () => {
    const { app } = await makeApp();
    app.tasks.create({ title: 'a', scheduledDate: '2026-11-16' });
    app.tasks.create({ title: 'b', deadline: '2026-11-18' });
    app.tasks.create({ title: 'c', scheduledDate: '2026-12-30' });
    expect(app.repos.tasks.listBetween('2026-11-15', '2026-11-21').map((t) => t.title)).toEqual(['a', 'b']);
  });
});

describe('time tracking', () => {
  it('timer start/stop and manual entries update actual time', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Focus work' });
    app.tasks.startTimer(t.id);
    expect(app.repos.tasks.get(t.id)!.status).toBe('in_progress');
    const entry = app.repos.time.running()!;
    app.repos.db.run('UPDATE time_entries SET started_at = ? WHERE id = ?', [new Date(Date.now() - 25 * 60000).toISOString(), entry.id]);
    expect(app.tasks.stopTimer()).toBe(25);
    app.tasks.addManualTime(t.id, 10);
    expect(app.repos.tasks.get(t.id)!.actualMinutes).toBe(35);
    expect(() => app.tasks.addManualTime(t.id, 0)).toThrow();
  });

  it('completing a task stops its running timer', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'x' });
    app.tasks.startTimer(t.id);
    app.tasks.complete(t.id);
    expect(app.repos.time.running()).toBeUndefined();
  });
});
