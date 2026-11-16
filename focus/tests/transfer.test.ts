import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, toCsv } from '@/core/csv';
import { makeApp } from './helpers';

describe('csv', () => {
  it('quotes and parses commas, quotes, newlines, BOM and semicolons', () => {
    const text = toCsv(['A', 'B'], [['x, y', 'say "hi"'], ['line1\nline2', '']]);
    expect(text.startsWith('﻿')).toBe(true);
    expect(parseCsv(text)).toEqual([['A', 'B'], ['x, y', 'say "hi"'], ['line1\nline2', '']]);
    expect(parseCsv('a;b\r\n1;2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('neutralises spreadsheet formulas but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('transfer', () => {
  it('round-trips tasks through CSV into a fresh database', async () => {
    const { app } = await makeApp();
    const home = app.projects.create({ name: 'Home' });
    const kitchen = app.projects.create({ name: 'Kitchen', parentId: home.id });
    const sec = app.projects.addSection(kitchen.id, 'Quotes');
    const lbl = app.labels.create({ name: 'calls' });
    const parent = app.tasks.create({ title: '=Get quotes, then decide', projectId: kitchen.id, sectionId: sec, priority: 2, labelIds: [lbl.id], scheduledDate: '2026-11-20', scheduledTime: '09:30', durationMinutes: 45, deadline: '2026-11-30', description: 'Line 1\nLine 2' });
    app.tasks.create({ title: 'Ring fitter "Bob"', parentId: parent.id });
    const weekly = app.quickAdd.commit((await import('@/core/nlp/parser')).parseQuickAdd('Water plants every Monday', { now: new Date(2026, 10, 14) }));
    const csv = app.transfer.exportCsv();
    expect(csv.count).toBe(3);

    const { app: other } = await makeApp();
    const preview = other.transfer.previewCsv(csv.text, csv.filename);
    expect(preview).toMatchObject({ format: 'focus', tasks: 3, newProjects: ['Home / Kitchen'], newLabels: ['calls'], skipped: 0 });
    const res = other.transfer.importCsv(csv.text, csv.filename);
    expect(res.created).toBe(3);
    const imported = other.repos.tasks.listForReports();
    const p = imported.find((t) => t.title === '=Get quotes, then decide')!;
    expect(p).toMatchObject({ priority: 2, scheduledDate: '2026-11-20', scheduledTime: '09:30', durationMinutes: 45, deadline: '2026-11-30', description: 'Line 1\nLine 2' });
    expect(other.repos.projects.get(p.projectId!)!.name).toBe('Kitchen');
    expect(other.repos.projects.getSection(p.sectionId!)!.name).toBe('Quotes');
    expect(other.repos.labels.get(p.labelIds[0]!)!.name).toBe('calls');
    expect(imported.find((t) => t.title === 'Ring fitter "Bob"')!.parentId).toBe(p.id);
    expect(imported.find((t) => t.title === 'Water plants')!.recurrence).toEqual(weekly.recurrence);

    // Importing the same file again skips tasks that already exist.
    const again = app.transfer.previewCsv(csv.text, csv.filename);
    expect(again).toMatchObject({ tasks: 0, skipped: 3 });
    expect(again.rows.every((r) => r.duplicate)).toBe(true);
  });

  it('imports a hand-made spreadsheet with UK dates and reports problems per row', async () => {
    const { app } = await makeApp();
    const text = 'Task,Due,Priority,Tags\r\nBook MOT,20/11/2026,p1,car\r\n,21/11/2026,,\r\nTidy shed,someday soon,3,\r\n';
    const pre = app.transfer.previewCsv(text);
    expect(pre.format).toBe('generic');
    expect(pre.rows[1]).toMatchObject({ line: 3, error: 'No title' });
    expect(pre.rows[2]!.warning).toMatch(/someday soon/);
    const res = app.transfer.importCsv(text);
    expect(res.created).toBe(2);
    const mot = app.repos.tasks.listForReports().find((t) => t.title === 'Book MOT')!;
    expect(mot).toMatchObject({ scheduledDate: '2026-11-20', priority: 1 });
    expect(() => app.transfer.previewCsv('Foo,Bar\r\n1,2')).toThrow(/Title/);
  });

  it('imports a Todoist project CSV with sections, subtasks, labels, dates and notes', async () => {
    const { app } = await makeApp();
    const todoist = [
      'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
      'section,Planning,,,,,,,,,,',
      'task,Book cottage @trip,Lake District,1,1,Me,,tomorrow,en,Europe/London,30,minute',
      'note,Check dog-friendly,,,,,,,,,,',
      'task,Pay deposit,,4,2,Me,,,en,,,',
      'task,Pack @trip,,2,1,Me,,every friday,en,,,',
      'task,Odd date,,4,1,Me,,whenever-ish,en,,,',
    ].join('\n');
    const pre = app.transfer.previewCsv(todoist, 'Holiday.csv');
    expect(pre).toMatchObject({ format: 'todoist', tasks: 4, newProjects: ['Holiday'], newLabels: ['trip'] });
    app.transfer.importCsv(todoist, 'Holiday.csv');
    const tasks = app.repos.tasks.listForReports();
    const book = tasks.find((t) => t.title === 'Book cottage')!;
    expect(book).toMatchObject({ priority: 1, durationMinutes: 30, description: 'Lake District' });
    expect(book.scheduledDate).not.toBeNull();
    expect(app.repos.projects.getSection(book.sectionId!)!.name).toBe('Planning');
    expect(app.repos.comments.listForTask(book.id).map((c) => c.body)).toEqual(['Check dog-friendly']);
    expect(tasks.find((t) => t.title === 'Pay deposit')!.parentId).toBe(book.id);
    expect(tasks.find((t) => t.title === 'Pack')!.recurrence).not.toBeNull();
    expect(tasks.find((t) => t.title === 'Odd date')!.description).toContain('whenever-ish');
  });

  it('exports and re-imports a project and a single task; imports can be undone', async () => {
    const { app } = await makeApp();
    const trip = app.projects.create({ name: 'Trip' });
    app.projects.addSection(trip.id, 'Before');
    const t = app.tasks.create({ title: 'Passports', projectId: trip.id });
    app.tasks.create({ title: 'Renew mine', parentId: t.id });
    app.content.addComment(t.id, 'Check expiry');
    const file = app.transfer.exportProject(trip.id);
    const res = app.transfer.importProjectFile(file.text);
    expect(app.repos.projects.get(res.projectIds[0]!)!.name).toBe('Trip (imported)');
    const copy = app.repos.tasks.listByProject(res.projectIds[0]!, { includeClosed: true });
    expect(copy.map((x) => x.title).sort()).toEqual(['Passports', 'Renew mine']);
    expect(app.repos.comments.listForTask(copy.find((x) => x.title === 'Passports')!.id)[0]!.body).toBe('Check expiry');

    const single = app.transfer.exportTask(t.id);
    const into = app.transfer.importProjectFile(single.text, { projectId: null });
    expect(into.created).toBe(2);
    expect(app.repos.tasks.listInbox().map((x) => x.title)).toContain('Passports');

    app.transfer.undoImport(into);
    expect(app.repos.tasks.listInbox().map((x) => x.title)).not.toContain('Passports');
    expect(() => app.transfer.inspectProjectFile('{"format":"other"}')).toThrow(/Focus project/);
  });

  it('does not trigger automations while importing', async () => {
    const { app } = await makeApp();
    app.automations.save({ name: 'Sub', trigger: { type: 'task.created' }, actions: [{ type: 'createSubtask', title: 'Auto subtask' }] });
    app.tasks.create({ title: 'Manual' });
    const before = app.repos.tasks.listForReports().filter((t) => t.title === 'Auto subtask').length;
    expect(before).toBe(1);
    app.transfer.importCsv('Title\r\nImported one\r\nImported two\r\n');
    expect(app.repos.tasks.listForReports().filter((t) => t.title === 'Auto subtask').length).toBe(1);
  });
});
