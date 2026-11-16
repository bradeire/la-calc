import { describe, expect, it } from 'vitest';
import { addDays } from '@/core/dates';
import { makeApp } from './helpers';

/** Spec 7.5: usable with tens of thousands of tasks. Thresholds are generous to avoid CI flakiness. */
describe('performance with 20,000 tasks', () => {
  it('core view queries stay fast', async () => {
    const { app, db } = await makeApp();
    const projects = Array.from({ length: 40 }, (_, i) => app.projects.create({ name: `Project ${i}` }).id);
    const labels = Array.from({ length: 20 }, (_, i) => app.labels.create({ name: `label${i}` }).id);
    const t0 = performance.now();
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) {
        app.tasks.create({
          title: `Task number ${i} about ${['invoices', 'garden', 'report', 'car', 'holiday'][i % 5]}`,
          description: i % 3 ? '' : 'Some longer description text for the search index',
          projectId: i % 4 ? projects[i % projects.length]! : null,
          scheduledDate: i % 2 ? addDays('2026-11-14', (i % 120) - 30) : null,
          deadline: i % 7 ? null : addDays('2026-11-14', i % 60),
          priority: ((i % 4) + 1) as 1 | 2 | 3 | 4,
          labelIds: i % 5 ? [] : [labels[i % labels.length]!],
        });
      }
    });
    const insertMs = performance.now() - t0;
    const time = (fn: () => unknown) => {
      const s = performance.now();
      fn();
      return performance.now() - s;
    };
    const r = {
      insertMs,
      today: time(() => app.repos.tasks.listToday('2026-11-14')),
      upcoming: time(() => app.repos.tasks.listBetween('2026-11-14', '2026-11-27')),
      inbox: time(() => app.repos.tasks.listInbox()),
      project: time(() => app.repos.tasks.listByProject(projects[3]!)),
      search: time(() => app.repos.tasks.search('garden desc')),
      counts: time(() => app.repos.projects.stats()),
      export: time(() => db.export()),
    };
    console.log('perf (ms):', Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])), 'db bytes', db.export().length);
    expect(r.today).toBeLessThan(400);
    expect(r.upcoming).toBeLessThan(400);
    expect(r.project).toBeLessThan(200);
    expect(r.search).toBeLessThan(300);
    expect(r.counts).toBeLessThan(200);
  }, 120_000);
});

describe('blocked lookup at scale', () => {
  it('stays fast for a 5,000-task list', async () => {
    const { app, db } = await makeApp();
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) app.tasks.create({ title: `t${i}` });
    });
    const ids = app.repos.tasks.listInbox().map((t) => t.id);
    app.tasks.addDependency(ids[1]!, ids[0]!);
    const s = performance.now();
    const blocked = app.repos.dependencies.blockedIds(ids);
    expect(performance.now() - s).toBeLessThan(100);
    expect([...blocked]).toEqual([ids[1]]);
  }, 60_000);
});
