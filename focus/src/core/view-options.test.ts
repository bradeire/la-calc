import { describe, expect, it } from 'vitest';
import type { Task } from './domain/types';
import { groupTasks, sortTasks, type Lookups, type ViewOptions } from './view-options';

const base: Omit<Task, 'id' | 'title'> = {
  description: '', projectId: null, sectionId: null, parentId: null, status: 'inbox', priority: 4, startDate: null,
  scheduledDate: null, scheduledTime: null, deadline: null, durationMinutes: null, recurrence: null, recurrenceText: null,
  labelIds: [], sortOrder: 0, collapsed: false, pinnedToday: false, completedAt: null, createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null,
} as unknown as Omit<Task, 'id' | 'title'>;
const t = (id: string, over: Partial<Task> = {}): Task => ({ ...base, id, title: id, ...over }) as Task;

const l: Lookups = {
  projectName: (id) => (id ? ({ h: 'Home', g: 'Garden' } as Record<string, string>)[id]! : 'Inbox'),
  projectOrder: (id) => (id ? ({ h: 1, g: 2 } as Record<string, number>)[id]! : 0),
  labelName: (id) => ({ c: 'calls', e: 'errands' } as Record<string, string>)[id] ?? null,
  today: '2026-11-17',
  prefs: { dateOrder: 'dmy', hour12: false, weekStartsOn: 1 },
};
const o = (sort: ViewOptions['sort'], dir: ViewOptions['dir'] = 'asc', group: ViewOptions['group'] = 'none'): ViewOptions => ({ sort, dir, group });
const ids = (ts: Task[]) => ts.map((x) => x.id);

describe('sortTasks', () => {
  const tasks = [
    t('b', { deadline: '2026-11-30', priority: 2, createdAt: '2026-11-03T00:00:00Z', projectId: 'g' }),
    t('a', { deadline: null, priority: 1, createdAt: '2026-11-01T00:00:00Z', projectId: 'h' }),
    t('C', { deadline: '2026-11-20', priority: 4, createdAt: '2026-11-02T00:00:00Z' }),
  ];
  it('by deadline, missing dates last in both directions', () => {
    expect(ids(sortTasks(tasks, o('deadline'), l))).toEqual(['C', 'b', 'a']);
    expect(ids(sortTasks(tasks, o('deadline', 'desc'), l))).toEqual(['b', 'C', 'a']);
  });
  it('by name (case-insensitive), priority, date added and project', () => {
    expect(ids(sortTasks(tasks, o('name'), l))).toEqual(['a', 'b', 'C']);
    expect(ids(sortTasks(tasks, o('priority'), l))).toEqual(['a', 'b', 'C']);
    expect(ids(sortTasks(tasks, o('created', 'desc'), l))).toEqual(['b', 'C', 'a']);
    expect(ids(sortTasks(tasks, o('project'), l))).toEqual(['C', 'a', 'b']);
  });
  it('manual keeps (or reverses) the incoming order; ties are stable', () => {
    expect(ids(sortTasks(tasks, o('manual'), l))).toEqual(['b', 'a', 'C']);
    expect(ids(sortTasks(tasks, o('manual', 'desc'), l))).toEqual(['C', 'a', 'b']);
    expect(ids(sortTasks([t('x'), t('y'), t('z')], o('deadline'), l))).toEqual(['x', 'y', 'z']);
  });
});

describe('groupTasks', () => {
  it('by label puts multi-label tasks in each group, unlabelled last', () => {
    const g = groupTasks([t('1', { labelIds: ['e', 'c'] }), t('2', { labelIds: ['c'] }), t('3')], 'label', l);
    expect(g.map((x) => [x.title, ids(x.tasks)])).toEqual([
      ['@calls', ['1', '2']],
      ['@errands', ['1']],
      ['No label', ['3']],
    ]);
  });
  it('by deadline buckets in date order, overdue first', () => {
    const g = groupTasks(
      [t('later', { deadline: '2026-12-25' }), t('none'), t('od', { deadline: '2026-11-01' }), t('tom', { deadline: '2026-11-18' }), t('wk', { deadline: '2026-11-21' }), t('nw', { deadline: '2026-11-25' })],
      'deadline',
      l,
    );
    expect(g.map((x) => x.title)).toEqual(['Overdue', 'Tomorrow', 'This week', 'Next week', 'Later', 'No date']);
    expect(g[0]!.tone).toBe('danger');
  });
  it('subtasks stay with their parent, by project order, Inbox first', () => {
    const g = groupTasks([t('p', { projectId: 'g' }), t('s', { projectId: 'g', parentId: 'p', labelIds: [] }), t('i')], 'project', l);
    expect(g.map((x) => [x.title, ids(x.tasks)])).toEqual([
      ['Inbox', ['i']],
      ['Garden', ['p', 's']],
    ]);
  });
  it('by priority and status', () => {
    expect(groupTasks([t('x', { priority: 4 }), t('y', { priority: 1 })], 'priority', l).map((x) => x.title)).toEqual(['Priority 1', 'No priority (P4)']);
    expect(groupTasks([t('x', { status: 'waiting' }), t('y', { status: 'in_progress' })], 'status', l).map((x) => ids(x.tasks))).toEqual([['y'], ['x']]);
  });
});
