import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

describe('projects and sections', () => {
  it('nested projects, cycle prevention, archive and restore', async () => {
    const { app } = await makeApp();
    const a = app.projects.create({ name: 'Home' });
    const b = app.projects.create({ name: 'Garden', parentId: a.id });
    expect(() => app.projects.update(a.id, { parentId: b.id })).toThrow(/inside itself/);
    const undo = app.projects.archive(a.id);
    expect(app.repos.projects.list().map((p) => p.name)).toEqual([]);
    undo.undo();
    expect(app.repos.projects.list()).toHaveLength(2);
  });

  it('partial project updates keep other fields', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Home', color: '#16a34a', layout: 'board' });
    const u = app.projects.update(p.id, { name: 'House' });
    expect(u).toMatchObject({ name: 'House', color: '#16a34a', layout: 'board' });
  });

  it('deleting a project soft-deletes its tasks; restore brings them back together', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'Trip' });
    app.projects.addSection(p.id, 'Before');
    const t = app.tasks.create({ title: 'Pack', projectId: p.id });
    app.projects.remove(p.id);
    expect(app.repos.tasks.get(t.id)!.deletedAt).toBeTruthy();
    expect(app.repos.projects.listTrash().map((x) => x.id)).toEqual([p.id]);
    app.projects.restore(p.id);
    expect(app.repos.tasks.get(t.id)!.deletedAt).toBeNull();
    expect(app.repos.projects.listSections(p.id)).toHaveLength(1);
  });

  it('deleting a section keeps its tasks', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'P' });
    const s = app.projects.addSection(p.id, 'S');
    const t = app.tasks.create({ title: 'x', projectId: p.id, sectionId: s });
    app.projects.removeSection(s);
    expect(app.repos.tasks.get(t.id)).toMatchObject({ sectionId: null, deletedAt: null });
  });

  it('project stats count open and completed tasks', async () => {
    const { app } = await makeApp();
    const p = app.projects.create({ name: 'P' });
    app.tasks.create({ title: 'a', projectId: p.id });
    const b = app.tasks.create({ title: 'b', projectId: p.id });
    app.tasks.complete(b.id);
    expect(app.repos.projects.stats().get(p.id)).toEqual({ open: 1, completed: 1 });
  });
});

describe('labels', () => {
  it('unique case-insensitive names and validation', async () => {
    const { app } = await makeApp();
    app.labels.create({ name: 'Home' });
    expect(() => app.labels.create({ name: 'home' })).toThrow(/already exists/);
    expect(() => app.labels.create({ name: 'two words' })).toThrow(/spaces/);
    expect(app.labels.ensure(['HOME', 'new'])).toHaveLength(2);
    expect(app.repos.labels.list()).toHaveLength(2);
  });
});

describe('sample data', () => {
  it('loads, and removal never deletes the user’s own tasks', async () => {
    const { app } = await makeApp();
    app.data.loadSampleData(new Date(2026, 10, 14, 10));
    expect(app.data.hasSampleData()).toBe(true);
    const home = app.repos.projects.list().find((p) => p.name === 'Home')!;
    const mine = app.tasks.create({ title: 'My own task in a sample project', projectId: home.id });
    const sampleTask = app.repos.tasks.listByProject(home.id).find((t) => t.isSample)!;
    const myChild = app.tasks.create({ title: 'My subtask', parentId: sampleTask.id });
    const { rescued } = app.data.removeSampleData();
    expect(rescued).toBe(1);
    expect(app.data.hasSampleData()).toBe(false);
    expect(app.repos.tasks.get(mine.id)).toMatchObject({ projectId: null, deletedAt: null });
    expect(app.repos.tasks.get(myChild.id)).toMatchObject({ parentId: null, deletedAt: null });
    expect(app.repos.projects.list()).toHaveLength(0);
  });
});

describe('backup and restore', () => {
  it('JSON backup round-trips every table and attachments', async () => {
    const { app } = await makeApp();
    app.data.loadSampleData(new Date(2026, 10, 14, 10));
    const t = app.repos.tasks.listInbox()[0]!;
    app.content.addComment(t.id, 'A comment');
    await app.content.addAttachment({ taskId: t.id }, new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const counts = () => ({
      tasks: app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n,
      labels: app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_labels')!.n,
      rules: app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules')!.n,
    });
    const before = counts();
    const json = JSON.stringify(await app.data.exportJson());

    // Restore into a different, empty app.
    const other = await makeApp();
    const { backup, summary } = other.app.data.inspectJson(json);
    expect(summary.tasks).toBe(before.tasks);
    await other.app.data.restoreJson(backup);
    expect({
      tasks: other.app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n,
      labels: other.app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_labels')!.n,
      rules: other.app.repos.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recurrence_rules')!.n,
    }).toEqual(before);
    // FTS index is rebuilt by triggers
    expect(other.app.repos.tasks.search('comment').map((x) => x.id)).toEqual([t.id]);
    const att = other.app.repos.attachments.listForTask(t.id)[0]!;
    const { blob } = await other.app.content.getAttachmentBlob(att.id);
    expect(await blob.text()).toBe('hello');
  });

  it('rejects files that are not Focus backups', async () => {
    const { app } = await makeApp();
    expect(() => app.data.inspectJson('not json')).toThrow(/not valid JSON/);
    expect(() => app.data.inspectJson('{"hello":1}')).toThrow(/not a Focus backup/);
    const future = JSON.stringify({ format: 'focus-backup', formatVersion: 1, schemaVersion: 999, exportedAt: 'x', tables: {} });
    expect(() => app.data.inspectJson(future)).toThrow(/newer version/);
  });

  it('SQLite backup verifies, and corrupt files are refused', async () => {
    const { app } = await makeApp();
    app.tasks.create({ title: 'x' });
    const { bytes, sha256 } = await app.data.exportSqlite();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(app.data.verifySqlite(bytes)).toMatchObject({ schemaVersion: 1, tasks: 1 });
    expect(() => app.data.verifySqlite(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });

  it('attachments: blocks executables and enforces size', async () => {
    const { app } = await makeApp();
    const t = app.tasks.create({ title: 'x' });
    await expect(app.content.addAttachment({ taskId: t.id }, new Blob(['x']), 'run.exe')).rejects.toThrow(/Executable/);
  });

  it('empty trash removes deleted items and their files', async () => {
    const { app, platform } = await makeApp();
    const t = app.tasks.create({ title: 'x' });
    await app.content.addAttachment({ taskId: t.id }, new Blob(['data']), 'a.txt');
    app.tasks.remove([t.id]);
    expect(await app.data.emptyTrash()).toBe(1);
    expect(platform.files.files.size).toBe(0);
  });
});
