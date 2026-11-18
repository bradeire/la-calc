import { describe, expect, it } from 'vitest';
import type { Task, TimeEntry } from './domain/types';
import {
  bucketsIn,
  completedByLabel,
  completedByProject,
  createdVsCompleted,
  dueDateTrend,
  priorityDistribution,
  projectProgress,
  recurringCompletion,
  timeReport,
  totals,
} from './insights';

const base: Task = {
  id: 'x', title: 'x', description: '', projectId: null, sectionId: null, parentId: null, priority: 4, status: 'active',
  startDate: null, scheduledDate: null, scheduledTime: null, deadline: null, durationMinutes: null, actualMinutes: 0,
  completedAt: null, createdAt: '', updatedAt: '', deletedAt: null, sortOrder: 0, pinnedToday: false, collapsed: false,
  seriesId: null, recurrence: null, recurrenceText: null, labelIds: [], isSample: false,
};
/** Local-time timestamp, so "local day" is the same in any time zone. */
const at = (day: string, h = 12) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, h).toISOString();
};
const t = (id: string, p: Partial<Task> = {}): Task => ({ ...base, id, title: id, createdAt: at('2026-11-01'), ...p });
const done = (id: string, day: string, p: Partial<Task> = {}) => t(id, { status: 'completed', completedAt: at(day), ...p });

const nov = { from: '2026-11-09', to: '2026-11-15' }; // Mon–Sun
const today = '2026-11-16';

describe('insights', () => {
  it('buckets by day, week and month', () => {
    expect(bucketsIn(nov, 'day')).toHaveLength(7);
    expect(bucketsIn({ from: '2026-11-11', to: '2026-11-24' }, 'week')).toEqual(['2026-11-09', '2026-11-16', '2026-11-23']);
    expect(bucketsIn({ from: '2026-11-20', to: '2027-01-05' }, 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });

  it('counts created and completed per day, ignoring deleted, reopened and out-of-range tasks', () => {
    const tasks = [
      done('a', '2026-11-10', { createdAt: at('2026-11-10', 8) }),
      done('b', '2026-11-10'),
      done('gone', '2026-11-10', { deletedAt: at('2026-11-11') }),
      t('reopened', { completedAt: null }),
      done('late', '2026-11-20'),
      t('new', { createdAt: at('2026-11-12') }),
    ];
    const series = createdVsCompleted(tasks, nov, 'day');
    expect(series.find((p) => p.bucket === '2026-11-10')).toEqual({ bucket: '2026-11-10', created: 1, completed: 2 });
    expect(series.find((p) => p.bucket === '2026-11-12')).toEqual({ bucket: '2026-11-12', created: 1, completed: 0 });
    expect(series.reduce((s, p) => s + p.completed, 0)).toBe(2);
    expect(totals(tasks, nov, today)).toMatchObject({ completed: 2, created: 2, open: 2 });
  });

  it('groups completions by project and label', () => {
    const tasks = [
      done('a', '2026-11-10', { projectId: 'home', labelIds: ['l1', 'l2'] }),
      done('b', '2026-11-11', { projectId: 'home' }),
      done('c', '2026-11-12', { labelIds: ['l1'] }),
    ];
    expect(completedByProject(tasks, nov)).toEqual([{ key: 'home', count: 2 }, { key: null, count: 1 }]);
    expect(completedByLabel(tasks, nov)).toEqual([{ key: 'l1', count: 2 }, { key: 'l2', count: 1 }, { key: null, count: 1 }]);
  });

  it('splits priorities into open now and completed in range', () => {
    const rows = priorityDistribution([t('a', { priority: 1 }), done('b', '2026-11-10', { priority: 1 }), t('c', { priority: 3, status: 'cancelled' })], nov);
    expect(rows[0]).toEqual({ priority: 1, open: 1, completed: 1 });
    expect(rows[2]).toEqual({ priority: 3, open: 0, completed: 0 });
  });

  it('tracks missed due dates using deadline before scheduled date', () => {
    const tasks = [
      done('onTime', '2026-11-10', { scheduledDate: '2026-11-10' }),
      done('lateDone', '2026-11-12', { deadline: '2026-11-10', scheduledDate: '2026-11-12' }),
      t('stillOpen', { scheduledDate: '2026-11-11' }),
      t('dueToday', { scheduledDate: today }),
    ];
    const pts = dueDateTrend(tasks, { from: '2026-11-09', to: today }, 'week', today);
    expect(pts[0]).toEqual({ bucket: '2026-11-09', due: 3, onTime: 1, missed: 2 });
    expect(pts[1]).toEqual({ bucket: '2026-11-16', due: 0, onTime: 0, missed: 0 });
  });

  it('compares recurring completions with what the pattern expected', () => {
    const rule = { v: 1 as const, freq: 'daily' as const, interval: 1, basis: 'scheduled' as const, anchor: '2026-11-09' };
    const s = { seriesId: 's1', title: 'Walk' };
    const tasks = [
      done('w1', '2026-11-09', { ...s, scheduledDate: '2026-11-09', recurrence: rule }),
      done('w2', '2026-11-10', { ...s, scheduledDate: '2026-11-10', recurrence: rule }),
      done('w3', '2026-11-12', { ...s, scheduledDate: '2026-11-12', recurrence: rule }),
      t('w4', { ...s, scheduledDate: '2026-11-17', recurrence: rule }),
    ];
    expect(recurringCompletion(tasks, nov, today)).toEqual([{ seriesId: 's1', title: 'Walk', completed: 3, expected: 7 }]);
    const after = { ...rule, basis: 'completion' as const };
    expect(recurringCompletion([done('d', '2026-11-10', { seriesId: 's2', recurrence: after })], nov, today)[0]?.expected).toBeNull();
  });

  it('reports project progress', () => {
    expect(projectProgress([t('a', { projectId: 'p' }), done('b', '2026-11-10', { projectId: 'p' }), t('c', { projectId: 'p', deletedAt: at('2026-11-10') })])).toEqual([
      { projectId: 'p', open: 1, completed: 1 },
    ]);
  });

  it('totals time by day, project and task, keeps running timers separate, and compares estimates', () => {
    const e = (id: string, taskId: string, day: string, minutes: number | null): TimeEntry => ({
      id, taskId, startedAt: at(day, 9), endedAt: minutes === null ? null : at(day, 10), minutes, note: '', source: 'timer',
      createdAt: at(day), updatedAt: at(day), deletedAt: null,
    });
    const tasks = [done('a', '2026-11-11', { projectId: 'p', durationMinutes: 60 }), t('b')];
    const entries = [e('1', 'a', '2026-11-10', 45), e('2', 'a', '2026-11-11', 30), e('3', 'b', '2026-11-11', 20), e('4', 'b', '2026-11-14', null)];
    const r = timeReport(entries, tasks, nov, new Date(2026, 10, 14, 11));
    expect(r.totalMinutes).toBe(95);
    expect(r.runningMinutes).toBe(120);
    expect(r.byDay.find((d) => d.day === '2026-11-11')?.minutes).toBe(50);
    expect(r.byWeek).toEqual([{ week: '2026-11-09', minutes: 95 }]);
    expect(r.byProject).toEqual([{ projectId: 'p', minutes: 75 }, { projectId: null, minutes: 20 }]);
    expect(r.estimateVsActual).toEqual([{ taskId: 'a', estimate: 60, actual: 75 }]);
  });
});
