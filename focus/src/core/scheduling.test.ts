import { describe, expect, it } from 'vitest';
import type { Task } from './domain/types';
import { capacityFor, findConflicts, suggestSchedule, workload, type SchedulingOptions } from './scheduling';

const base: Task = {
  id: 'x', title: 'x', description: '', projectId: null, sectionId: null, parentId: null, priority: 4, status: 'active',
  startDate: null, scheduledDate: null, scheduledTime: null, deadline: null, durationMinutes: null, actualMinutes: 0,
  completedAt: null, createdAt: '', updatedAt: '', deletedAt: null, sortOrder: 0, pinnedToday: false, collapsed: false,
  seriesId: null, recurrence: null, recurrenceText: null, labelIds: [], isSample: false,
};
const t = (id: string, p: Partial<Task>): Task => ({ ...base, id, title: id, ...p });

// Monday 16 Nov 2026; 4-hour working days Mon–Fri.
const o: SchedulingOptions = {
  today: '2026-11-16',
  hours: { days: [0, 1, 2, 3, 4], start: '09:00', end: '13:00' },
  defaultEstimate: 30,
  horizonDays: 14,
};

describe('capacity and workload', () => {
  it('uses working days and hours', () => {
    expect(capacityFor('2026-11-16', o.hours)).toBe(240);
    expect(capacityFor('2026-11-21', o.hours)).toBe(0); // Saturday
  });
  it('sums estimates and counts unestimated tasks at the default', () => {
    const [mon] = workload([t('a', { scheduledDate: '2026-11-16', durationMinutes: 120 }), t('b', { scheduledDate: '2026-11-16' })], '2026-11-16', '2026-11-16', o);
    expect(mon).toMatchObject({ estimated: 120, unestimated: 1, planned: 150, overloaded: false });
  });
});

describe('conflicts', () => {
  it('detects overload, overlaps, deadline/start/dependency problems and overdue work', () => {
    const tasks = [
      t('big1', { scheduledDate: '2026-11-17', durationMinutes: 180 }),
      t('big2', { scheduledDate: '2026-11-17', durationMinutes: 120 }),
      t('m1', { scheduledDate: '2026-11-18', scheduledTime: '09:00', durationMinutes: 60 }),
      t('m2', { scheduledDate: '2026-11-18', scheduledTime: '09:30', durationMinutes: 30 }),
      t('late', { scheduledDate: '2026-11-20', deadline: '2026-11-19' }),
      t('early', { scheduledDate: '2026-11-18', startDate: '2026-11-19' }),
      t('pre', { scheduledDate: '2026-11-25' }),
      t('dep', { scheduledDate: '2026-11-19' }),
      t('old', { scheduledDate: '2026-11-10', durationMinutes: 45 }),
    ];
    const kinds = findConflicts(tasks, [{ taskId: 'dep', dependsOnId: 'pre' }], o).map((c) => c.kind + ('date' in c ? `@${c.date}` : '') + ('taskId' in c ? `:${c.taskId}` : ''));
    expect(kinds).toEqual(
      expect.arrayContaining(['overdue', 'overloaded@2026-11-17', 'overlap@2026-11-18', 'afterDeadline:late', 'beforeStart:early', 'dependencyOrder:dep']),
    );
  });
  it('flags deadlines at risk when the work cannot fit', () => {
    const tasks = [t('huge', { deadline: '2026-11-17', durationMinutes: 600 })]; // 10 h, only 8 h available Mon–Tue
    expect(findConflicts(tasks, [], o).some((c) => c.kind === 'deadlineAtRisk')).toBe(true);
  });
});

describe('suggestions', () => {
  it('moves the least important flexible task off an overloaded day', () => {
    const tasks = [
      t('p1', { priority: 1, scheduledDate: '2026-11-16', durationMinutes: 180 }),
      t('p4', { priority: 4, scheduledDate: '2026-11-16', durationMinutes: 120 }),
    ];
    const s = suggestSchedule(tasks, [], o);
    expect(s).toEqual([expect.objectContaining({ taskId: 'p4', from: '2026-11-16', to: '2026-11-17' })]);
  });
  it('never moves fixed-time tasks or tasks due that day', () => {
    const tasks = [
      t('fixed', { scheduledDate: '2026-11-16', scheduledTime: '09:00', durationMinutes: 200 }),
      t('due', { scheduledDate: '2026-11-16', deadline: '2026-11-16', durationMinutes: 200 }),
    ];
    expect(suggestSchedule(tasks, [], o)).toEqual([]);
  });
  it('places overdue work on the next day with room, highest priority first', () => {
    const tasks = [
      t('today-full', { scheduledDate: '2026-11-16', durationMinutes: 240, scheduledTime: '09:00' }),
      t('old-p4', { priority: 4, scheduledDate: '2026-11-10', durationMinutes: 60 }),
      t('old-p1', { priority: 1, scheduledDate: '2026-11-12', durationMinutes: 200 }),
    ];
    const s = suggestSchedule(tasks, [], o);
    expect(s.map((x) => [x.taskId, x.to])).toEqual([
      ['old-p1', '2026-11-17'],
      ['old-p4', '2026-11-18'],
    ]);
  });
  it('schedules unscheduled deadline work before the deadline, after its start date and prerequisites', () => {
    const tasks = [
      t('pre', { scheduledDate: '2026-11-18', durationMinutes: 60 }),
      t('report', { deadline: '2026-11-20', durationMinutes: 60, startDate: '2026-11-17' }),
    ];
    const s = suggestSchedule(tasks, [{ taskId: 'report', dependsOnId: 'pre' }], o);
    expect(s).toEqual([expect.objectContaining({ taskId: 'report', to: '2026-11-18' })]);
  });
  it('fixes a dependant planned before its prerequisite', () => {
    const tasks = [t('pre', { scheduledDate: '2026-11-19' }), t('dep', { scheduledDate: '2026-11-17' })];
    const s = suggestSchedule(tasks, [{ taskId: 'dep', dependsOnId: 'pre' }], o);
    expect(s).toEqual([expect.objectContaining({ taskId: 'dep', to: '2026-11-19' })]);
  });
  it('skips weekends', () => {
    const tasks = [t('fri', { scheduledDate: '2026-11-20', durationMinutes: 240 }), t('more', { priority: 4, scheduledDate: '2026-11-20', durationMinutes: 60 })];
    expect(suggestSchedule(tasks, [], o)[0]).toMatchObject({ taskId: 'more', to: '2026-11-23' });
  });
});
