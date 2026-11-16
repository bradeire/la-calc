import { describe, expect, it } from 'vitest';
import { ConfirmationRequired, ValidationError } from '@/services/events';
import { makeApp } from './helpers';

describe('dependencies', () => {
  it('adds, blocks, prevents cycles and self-links', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'A' });
    const b = app.tasks.create({ title: 'B' });
    const c = app.tasks.create({ title: 'C' });
    app.tasks.addDependency(b.id, a.id); // B waits for A
    app.tasks.addDependency(c.id, b.id); // C waits for B
    expect(app.repos.dependencies.blockedIds()).toEqual(new Set([b.id, c.id]));
    expect(() => app.tasks.addDependency(a.id, c.id)).toThrow(/circular/);
    expect(() => app.tasks.addDependency(a.id, a.id)).toThrow(ValidationError);
    app.tasks.complete(a.id);
    expect(app.repos.dependencies.blockedIds()).toEqual(new Set([c.id]));
  });

  it('asks before completing a blocked task; force completes it', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'Get quotes' });
    const b = app.tasks.create({ title: 'Choose fitter' });
    app.tasks.addDependency(b.id, a.id);
    expect(() => app.tasks.complete(b.id)).toThrow(ConfirmationRequired);
    expect(app.repos.tasks.get(b.id)!.status).toBe('inbox');
    app.tasks.complete(b.id, { force: true });
    expect(app.repos.tasks.get(b.id)!.status).toBe('completed');
  });

  it('asks before scheduling a task before its prerequisite (and vice versa)', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'A', scheduledDate: '2026-11-20' });
    const b = app.tasks.create({ title: 'B' });
    app.tasks.addDependency(b.id, a.id);
    expect(() => app.tasks.update(b.id, { scheduledDate: '2026-11-18' })).toThrow(/planned for/);
    expect(app.tasks.update(b.id, { scheduledDate: '2026-11-21' }).scheduledDate).toBe('2026-11-21');
    expect(() => app.tasks.update(a.id, { scheduledDate: '2026-11-25' })).toThrow(/depends on this task/);
    expect(app.tasks.update(a.id, { scheduledDate: '2026-11-25' }, { force: true }).scheduledDate).toBe('2026-11-25');
  });

  it('undo removes the dependency', async () => {
    const { app } = await makeApp();
    const a = app.tasks.create({ title: 'A' });
    const b = app.tasks.create({ title: 'B' });
    app.tasks.addDependency(b.id, a.id).undo();
    expect(app.repos.dependencies.prerequisitesOf(b.id)).toEqual([]);
  });
});

describe('reminders', () => {
  it('relative reminder fires before the scheduled time, once, and can be snoozed or dismissed', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Dentist', scheduledDate: '2026-11-20', scheduledTime: '10:00' });
    const rid = app.content.addReminder(t.id, { kind: 'relative', offsetMinutes: 30 });
    expect(app.reminders.due(new Date(2026, 10, 20, 9, 29))).toHaveLength(0);
    expect(app.reminders.nextDueAt(new Date(2026, 10, 20, 9, 0))).toEqual(new Date(2026, 10, 20, 9, 30));
    const due = app.reminders.due(new Date(2026, 10, 20, 9, 31));
    expect(due.map((d) => d.task.title)).toEqual(['Dentist']);
    app.reminders.markDelivered([rid], new Date(2026, 10, 20, 9, 31));
    expect(app.reminders.due(new Date(2026, 10, 20, 9, 45))).toHaveLength(0);
    app.reminders.snooze(rid, 10, new Date(2026, 10, 20, 9, 45));
    expect(app.reminders.due(new Date(2026, 10, 20, 9, 50))).toHaveLength(0);
    expect(app.reminders.due(new Date(2026, 10, 20, 9, 56))).toHaveLength(1);
    app.reminders.dismiss(rid);
    expect(app.reminders.due(new Date(2026, 10, 20, 12, 0))).toHaveLength(0);
  });

  it('marks long-overdue reminders as missed and skips completed tasks', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Call', deadline: '2026-11-20' });
    app.content.addReminder(t.id, { kind: 'relative', offsetMinutes: 0 }); // 09:00 on deadline day
    expect(app.reminders.due(new Date(2026, 10, 20, 15, 0))[0]!.missed).toBe(true);
    app.tasks.complete(t.id);
    expect(app.reminders.due(new Date(2026, 10, 20, 15, 0))).toHaveLength(0);
  });

  it('rescheduling re-arms a delivered relative reminder', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'Meet', scheduledDate: '2026-11-20', scheduledTime: '10:00' });
    const rid = app.content.addReminder(t.id, { kind: 'relative', offsetMinutes: 0 });
    app.reminders.markDelivered([rid]);
    app.tasks.update(t.id, { scheduledDate: '2026-11-21' });
    expect(app.reminders.due(new Date(2026, 10, 21, 10, 1))).toHaveLength(1);
  });

  it('absolute reminders move with recurring tasks', async () => {
    const { app } = await makeApp(new Date(2026, 10, 16, 8, 0));
    const rule = { v: 1 as const, freq: 'weekly' as const, interval: 1, basis: 'scheduled' as const, anchor: '2026-11-16' };
    const t = app.tasks.create({ title: 'Bins', scheduledDate: '2026-11-16', recurrence: rule });
    app.content.addReminder(t.id, { kind: 'absolute', remindAt: new Date(2026, 10, 16, 19, 0).toISOString() });
    app.tasks.complete(t.id);
    const next = app.repos.tasks.listInbox()[0]!;
    expect(new Date(app.repos.reminders.listForTask(next.id)[0]!.remindAt!)).toEqual(new Date(2026, 10, 23, 19, 0));
  });
});

describe('templates', () => {
  it('built-in holiday template generates sections, tasks, subtasks, relative dates and dependencies', async () => {
    const { app } = await makeApp();
    const p = app.templates.instantiate('builtin:holiday', { name: 'Lisbon', startDate: '2027-03-01' });
    const tasks = app.repos.tasks.listByProject(p.id);
    const by = (title: string) => tasks.find((t) => t.title === title)!;
    expect(app.repos.projects.listSections(p.id).map((s) => s.name)).toEqual(['Plan', 'Book', 'Prepare']);
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['Research destination', 'Book accommodation', 'Arrange transport', 'Check travel documents', 'Prepare packing list', 'Confirm arrangements']));
    expect(by('Book accommodation')).toMatchObject({ scheduledDate: '2027-03-04', deadline: '2027-03-08', priority: 1 });
    expect(by('Medication and chargers').parentId).toBe(by('Prepare packing list').id);
    expect(app.repos.dependencies.prerequisitesOf(by('Confirm arrangements').id).length).toBe(2);
  });

  it('saves a project as a template and recreates it with shifted dates', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Launch' });
    app.projects.addSection(p.id, 'Prep');
    const l = app.labels.create({ name: 'calls' });
    const a = app.tasks.create({ title: 'Brief', projectId: p.id, scheduledDate: '2026-11-10', labelIds: [l.id] });
    const b = app.tasks.create({ title: 'Ship', projectId: p.id, deadline: '2026-11-17' });
    app.tasks.create({ title: 'Checklist', parentId: b.id });
    app.tasks.addDependency(b.id, a.id);
    const tid = app.templates.saveProjectAsTemplate(p.id, 'Launch plan');
    const copy = app.templates.instantiate(tid, { name: 'Launch 2', startDate: '2027-01-04' });
    const tasks = app.repos.tasks.listByProject(copy.id);
    const brief = tasks.find((t) => t.title === 'Brief')!;
    const ship = tasks.find((t) => t.title === 'Ship')!;
    expect(brief).toMatchObject({ scheduledDate: '2027-01-04', labelIds: [l.id] });
    expect(ship.deadline).toBe('2027-01-11');
    expect(app.repos.tasks.children(ship.id).map((c) => c.title)).toEqual(['Checklist']);
    expect(app.repos.dependencies.prerequisitesOf(ship.id)).toEqual([brief.id]);
    expect(app.templates.list().some((t) => t.name === 'Launch plan')).toBe(true);
  });

  it('cannot delete built-ins; deleting own templates is undoable', async () => {
    const { app } = await makeApp();
    expect(() => app.templates.remove('builtin:holiday')).toThrow();
    const p = app.projects.create({ name: 'X' });
    const tid = app.templates.saveProjectAsTemplate(p.id, 'X');
    app.templates.remove(tid).undo();
    expect(app.templates.list().some((t) => t.id === tid)).toBe(true);
  });
});

describe('saved filters', () => {
  it('saves, runs and excludes archived projects', async () => {
    const { app } = await makeApp(new Date(2026, 10, 16, 9));
    const home = app.projects.create({ name: 'Home' });
    const old = app.projects.create({ name: 'Old' });
    app.tasks.create({ title: 'overdue home', projectId: home.id, scheduledDate: '2026-11-10' });
    app.tasks.create({ title: 'overdue old', projectId: old.id, scheduledDate: '2026-11-10' });
    app.projects.archive(old.id);
    const parsed = app.filters.parse('overdue');
    const id = app.filters.save({ name: 'Overdue', definition: parsed.definition! });
    const saved = app.filters.list().find((f) => f.id === id)!;
    expect(saved.query).toBe('overdue');
    expect(app.filters.run(saved.definition!.root).map((t) => t.title)).toEqual(['overdue home']);
  });
});
