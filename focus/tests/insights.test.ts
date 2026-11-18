import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/services/events';
import { makeApp } from './helpers';

const NOW = new Date(2026, 10, 14, 10, 0); // Saturday 14 Nov 2026

describe('insights service', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reports completions, projects, labels and time from stored data', async () => {
    const { app } = await makeApp(NOW);
    const home = app.projects.create({ name: 'Home' });
    const garden = app.labels.create({ name: 'garden' });
    const a = app.tasks.create({ title: 'Mow lawn', projectId: home.id, labelIds: [garden.id], priority: 2 });
    const b = app.tasks.create({ title: 'Call bank', projectId: home.id });
    app.tasks.create({ title: 'Open one' });
    app.tasks.complete(a.id);
    app.tasks.complete(b.id);
    app.tasks.addManualTime(a.id, 40, new Date(2026, 10, 14, 8).toISOString());
    const r = app.insights.report({ from: '2026-11-09', to: '2026-11-15' });
    expect(r.totals).toMatchObject({ completed: 2, created: 3, open: 1 });
    expect(r.byProject).toEqual([{ key: home.id, count: 2 }]);
    expect(r.byLabel).toEqual([{ key: garden.id, count: 1 }, { key: null, count: 1 }]);
    expect(r.createdVsCompleted.find((p) => p.bucket === '2026-11-14')).toMatchObject({ created: 3, completed: 2 });
    expect(r.time.totalMinutes).toBe(40);
    expect(r.time.byProject).toEqual([{ projectId: home.id, minutes: 40 }]);
    expect(r.lists.recent.map((t) => t.title).sort()).toEqual(['Call bank', 'Mow lawn']);
  });

  it('tracks goals and corrects time entries', async () => {
    const { app } = await makeApp(NOW);
    app.insights.setGoals({ dailyTasks: 2, weeklyTasks: null, dailyMinutes: null, weeklyMinutes: null, skipNonWorkingDays: true });
    const t1 = app.tasks.create({ title: 'One' });
    app.tasks.complete(t1.id);
    expect(app.insights.goalStatus()).toMatchObject({ today: { completed: 1 }, todayMet: false });
    app.tasks.complete(app.tasks.create({ title: 'Two' }).id);
    expect(app.insights.goalStatus()).toMatchObject({ todayMet: true, daily: { current: 1 } });

    app.tasks.addManualTime(t1.id, 90, new Date(2026, 10, 14, 7).toISOString());
    const [entry] = app.insights.timeLog({ from: '2026-11-14', to: '2026-11-14' });
    app.tasks.correctTimeEntry(entry!.id, { startedAt: new Date(2026, 10, 14, 7, 30).toISOString(), minutes: 45, note: 'fixed' });
    expect(app.repos.tasks.get(t1.id)!.actualMinutes).toBe(45);
    expect(app.insights.timeLog({ from: '2026-11-14', to: '2026-11-14' })[0]).toMatchObject({ minutes: 45, note: 'fixed' });
    expect(() => app.tasks.correctTimeEntry(entry!.id, { startedAt: 'nonsense', minutes: 10 })).toThrow(ValidationError);
  });

  it('flags a long-running timer and lets it be stopped at an earlier time', async () => {
    const { app } = await makeApp(NOW);
    const t = app.tasks.create({ title: 'Tax return' });
    vi.setSystemTime(new Date(2026, 10, 14, 4, 0));
    app.tasks.startTimer(t.id);
    vi.setSystemTime(NOW);
    const long = app.insights.longRunningTimer();
    expect(long).toMatchObject({ taskId: t.id, minutes: 360 });
    expect(() => app.tasks.stopTimerAt(new Date(2026, 10, 14, 3).toISOString())).toThrow(/after the timer started/);
    expect(app.tasks.stopTimerAt(new Date(2026, 10, 14, 5, 30).toISOString())).toBe(90);
    expect(app.insights.longRunningTimer()).toBeNull();
    expect(app.repos.tasks.get(t.id)!.actualMinutes).toBe(90);
  });
});
