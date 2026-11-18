import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/types';
import { applyFilter, resolveRange, type FilterContext } from './evaluate';
import { parseQuery, toQuery } from './query';

const base: Task = {
  id: 'x', title: 'Task', description: '', projectId: null, sectionId: null, parentId: null, priority: 4, status: 'active',
  startDate: null, scheduledDate: null, scheduledTime: null, deadline: null, durationMinutes: null, actualMinutes: 0,
  completedAt: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '', deletedAt: null, sortOrder: 0, pinnedToday: false,
  collapsed: false, seriesId: null, recurrence: null, recurrenceText: null, labelIds: [], isSample: false,
};
const t = (id: string, p: Partial<Task>): Task => ({ ...base, id, title: id, ...p });

// Monday 16 November 2026
const ctx: FilterContext = {
  today: '2026-11-16',
  weekStartsOn: 1,
  projectTree: new Map([
    ['home', new Set(['home', 'garden'])],
    ['garden', new Set(['garden'])],
    ['archived', new Set(['archived'])],
  ]),
  blocked: new Set(['b']),
  blocking: new Set(['a']),
};
const lk = {
  projects: [{ id: 'home', name: 'Home' }, { id: 'garden', name: 'Garden' }, { id: 'hi', name: 'Home Improvements' }],
  labels: [{ id: 'l-wait', name: 'waiting-on' }, { id: 'l-calls', name: 'calls' }],
};

const tasks = [
  t('p1-task', { priority: 1 }),
  t('due-wed', { scheduledDate: '2026-11-18' }),
  t('deadline-sun', { deadline: '2026-11-22' }),
  t('next-week', { scheduledDate: '2026-11-24' }),
  t('waiting', { status: 'waiting' }),
  t('quick', { durationMinutes: 10, scheduledDate: '2026-11-16' }),
  t('long', { durationMinutes: 90 }),
  t('home-deadline', { projectId: 'garden', deadline: '2026-11-30' }),
  t('home-no-deadline', { projectId: 'home' }),
  t('overdue', { scheduledDate: '2026-11-10' }),
  t('overdue-deadline', { deadline: '2026-11-15' }),
  t('done', { status: 'completed', completedAt: '2026-11-16T09:00:00.000Z', priority: 1 }),
  t('a', { labelIds: ['l-calls'] }),
  t('b', { labelIds: ['l-calls', 'l-wait'] }),
];

const run = (q: string) => {
  const r = parseQuery(q, lk);
  if (!r.definition) throw new Error(r.error ?? 'parse failed');
  return applyFilter(r.definition.root, tasks, ctx).map((x) => x.id).sort();
};

describe('spec example filters', () => {
  it('All P1 tasks (open only by default)', () => expect(run('p1')).toEqual(['p1-task']));
  it('Tasks due this week (scheduled or deadline)', () =>
    expect(run('due:this-week')).toEqual(['deadline-sun', 'due-wed', 'quick']));
  it('Tasks without a scheduled date', () => expect(run('scheduled:none')).not.toContain('due-wed'));
  it('Tasks awaiting others', () => expect(run('status:waiting')).toEqual(['waiting']));
  it('Tasks taking less than 15 minutes', () => expect(run('duration<15')).toEqual(['quick']));
  it('Tasks in Home (incl. sub-projects) with a deadline this month', () => expect(run('#Home & deadline:this-month')).toEqual(['home-deadline']));
  it('Overdue tasks', () => expect(run('overdue')).toEqual(['overdue', 'overdue-deadline']));
});

describe('query language', () => {
  it('OR, NOT, grouping and implicit AND', () => {
    expect(run('(p1 | overdue) & !scheduled:any')).toEqual(['overdue-deadline', 'p1-task']);
    expect(run('@calls !@waiting-on')).toEqual(['a']);
  });
  it('labels: any, none', () => {
    expect(run('@calls')).toEqual(['a', 'b']);
    expect(run('@none & #Home')).toEqual(['home-deadline', 'home-no-deadline']);
  });
  it('dependencies', () => {
    expect(run('blocked')).toEqual(['b']);
    expect(run('blocking')).toEqual(['a']);
  });
  it('status mention includes closed tasks', () => expect(run('p1 & status:completed')).toEqual(['done']));
  it('completed date', () => expect(run('completed:today')).toEqual(['done']));
  it('date comparisons and ranges', () => {
    expect(run('scheduled<today')).toEqual(['overdue']);
    expect(run('scheduled:2026-11-17..2026-11-30')).toEqual(['due-wed', 'next-week']);
    expect(run('scheduled>=+7d')).toEqual(['next-week']);
  });
  it('quoted multi-word project names', () => {
    const r = parseQuery('#"Home Improvements"', lk);
    expect(r.definition?.root).toMatchObject({ field: 'project', value: ['hi'] });
  });
  it('bare words are text search', () => expect(run('quick')).toEqual(['quick']));
  it('clear errors', () => {
    expect(parseQuery('#Nowhere', lk).error).toMatch(/No project called/);
    expect(parseQuery('(p1 | p2', lk).error).toMatch(/closing bracket/);
    expect(parseQuery('status:sleeping', lk).error).toMatch(/Unknown status/);
    expect(parseQuery('', lk).error).toBeTruthy();
  });
  it('round-trips through toQuery', () => {
    for (const q of ['p1 & due:this-week', '(p1 | overdue) & !@waiting-on', '#"Home Improvements" & duration<=30', 'scheduled:2026-11-01..2026-11-30 | @none', 'priority<=2 & !recurring']) {
      const a = parseQuery(q, lk).definition!;
      const text = toQuery(a.root, lk);
      expect(parseQuery(text, lk).definition).toEqual(a);
    }
  });
});

describe('ranges', () => {
  it('this-week respects week start', () => {
    expect(resolveRange('this-week', '2026-11-16', 1)).toEqual(['2026-11-16', '2026-11-22']);
    expect(resolveRange('this-week', '2026-11-16', 0)).toEqual(['2026-11-15', '2026-11-21']);
    expect(resolveRange('next-7-days', '2026-11-16', 1)).toEqual(['2026-11-16', '2026-11-22']);
    expect(resolveRange('next-month', '2026-11-16', 1)).toEqual(['2026-12-01', '2026-12-31']);
  });
});
