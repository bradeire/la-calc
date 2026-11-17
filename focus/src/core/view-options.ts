/**
 * Per-view sort and grouping of task lists (Inbox, Today, projects, labels, filters, search).
 * Pure functions: the UI stores the chosen options per view and renders the groups.
 */
import { z } from 'zod';
import { addDays, diffDays, startOfWeek, type DatePrefs } from './dates';
import { STATUS_LABELS, type Task } from './domain/types';

export const SORT_KEYS = ['manual', 'deadline', 'scheduled', 'created', 'project', 'name', 'priority'] as const;
export const GROUP_KEYS = ['none', 'project', 'label', 'priority', 'deadline', 'scheduled', 'status'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type GroupKey = (typeof GROUP_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  manual: 'Manual (your order)',
  deadline: 'Deadline',
  scheduled: 'Scheduled date',
  created: 'Date added',
  project: 'Project',
  name: 'Name (A–Z)',
  priority: 'Priority',
};
export const GROUP_LABELS: Record<GroupKey, string> = {
  none: 'None',
  project: 'Project',
  label: 'Label',
  priority: 'Priority',
  deadline: 'Deadline',
  scheduled: 'Scheduled date',
  status: 'Status',
};

export const viewOptionsSchema = z.object({
  sort: z.enum(SORT_KEYS).default('manual'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  group: z.enum(GROUP_KEYS).default('none'),
});
export type ViewOptions = z.infer<typeof viewOptionsSchema>;
export const DEFAULT_VIEW_OPTIONS: ViewOptions = { sort: 'manual', dir: 'asc', group: 'none' };

export interface Lookups {
  projectName: (id: string | null) => string;
  /** Project order as shown in the sidebar (for grouping/sorting by project). */
  projectOrder: (id: string | null) => number;
  labelName: (id: string) => string | null;
  today: string;
  prefs: DatePrefs;
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Missing dates sort last in either direction; ties keep manual order. */
export function sortTasks(tasks: readonly Task[], opts: ViewOptions, l: Lookups): Task[] {
  if (opts.sort === 'manual') return opts.dir === 'desc' ? [...tasks].reverse() : [...tasks];
  const sign = opts.dir === 'desc' ? -1 : 1;
  const date = (t: Task): string | null =>
    opts.sort === 'deadline' ? t.deadline : opts.sort === 'scheduled' ? (t.scheduledDate ? `${t.scheduledDate} ${t.scheduledTime ?? '99:99'}` : null) : null;
  const cmp = (a: Task, b: Task): number => {
    switch (opts.sort) {
      case 'deadline':
      case 'scheduled': {
        const da = date(a);
        const db = date(b);
        if (!da || !db) return da ? -1 : db ? 1 : 0;
        return sign * byText(da, db);
      }
      case 'created':
        return sign * byText(a.createdAt, b.createdAt);
      case 'project':
        return sign * (l.projectOrder(a.projectId) - l.projectOrder(b.projectId) || byText(l.projectName(a.projectId), l.projectName(b.projectId)));
      case 'name':
        return sign * byText(a.title, b.title);
      case 'priority':
        return sign * (a.priority - b.priority);
      default:
        return 0;
    }
  };
  // Stable: equal items keep their incoming (manual) order.
  return tasks.map((t, i) => [t, i] as const).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(([t]) => t);
}

export interface TaskGroup {
  key: string;
  title: string;
  tone?: 'danger';
  tasks: Task[];
}

/** Buckets for date grouping, in order. */
function dateBucket(d: string | null, l: Lookups): { key: string; title: string; order: number; tone?: 'danger' } {
  if (!d) return { key: 'none', title: 'No date', order: 9 };
  const diff = diffDays(d, l.today);
  if (diff < 0) return { key: 'overdue', title: 'Overdue', order: 0, tone: 'danger' };
  if (diff === 0) return { key: 'today', title: 'Today', order: 1 };
  if (diff === 1) return { key: 'tomorrow', title: 'Tomorrow', order: 2 };
  const nextWeek = addDays(startOfWeek(l.today, l.prefs.weekStartsOn), 7);
  if (d < nextWeek) return { key: 'week', title: 'This week', order: 3 };
  if (d < addDays(nextWeek, 7)) return { key: 'nextweek', title: 'Next week', order: 4 };
  return { key: 'later', title: 'Later', order: 5 };
}

/**
 * Group (already sorted) tasks. Grouping by label puts a task with several labels in each of
 * its labels' groups. Subtasks follow their parent so trees stay intact.
 */
export function groupTasks(tasks: readonly Task[], group: GroupKey, l: Lookups): TaskGroup[] {
  if (group === 'none') return [{ key: 'all', title: '', tasks: [...tasks] }];
  const ids = new Set(tasks.map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Group by the top-most ancestor present in the list, so subtasks stay with their parent.
  const root = (t: Task): Task => {
    let cur = t;
    const seen = new Set<string>();
    while (cur.parentId && ids.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur;
  };
  type Bucket = { key: string; title: string; order: number | string; tone?: 'danger' };
  const bucketsFor = (t: Task): Bucket[] => {
    switch (group) {
      case 'project':
        return [{ key: t.projectId ?? 'inbox', title: l.projectName(t.projectId), order: l.projectOrder(t.projectId) }];
      case 'label': {
        const names = t.labelIds.map((id) => [id, l.labelName(id)] as const).filter((x): x is readonly [string, string] => !!x[1]);
        return names.length ? names.map(([id, name]) => ({ key: id, title: `@${name}`, order: name.toLowerCase() })) : [{ key: 'none', title: 'No label', order: '￿' }];
      }
      case 'priority':
        return [{ key: `p${t.priority}`, title: t.priority === 4 ? 'No priority (P4)' : `Priority ${t.priority}`, order: t.priority }];
      case 'deadline':
        return [dateBucket(t.deadline, l)];
      case 'scheduled':
        return [dateBucket(t.scheduledDate, l)];
      case 'status':
        return [{ key: t.status, title: STATUS_LABELS[t.status], order: ['in_progress', 'active', 'inbox', 'waiting', 'completed', 'cancelled'].indexOf(t.status) }];
    }
  };
  const groups = new Map<string, Bucket & { tasks: Task[] }>();
  for (const t of tasks) {
    for (const b of bucketsFor(root(t))) {
      const g = groups.get(b.key) ?? { ...b, tasks: [] };
      g.tasks.push(t);
      groups.set(b.key, g);
    }
  }
  return [...groups.values()]
    .sort((a, b) => (typeof a.order === 'number' && typeof b.order === 'number' ? a.order - b.order : byText(String(a.order), String(b.order))))
    .map(({ key, title, tone, tasks: ts }) => ({ key, title, ...(tone ? { tone } : {}), tasks: ts }));
}

/** Short description of the active options, e.g. "Deadline ↓ · grouped by label". */
export function describeOptions(o: ViewOptions): string {
  const parts: string[] = [];
  if (o.sort !== 'manual' || o.dir === 'desc') parts.push(`${o.sort === 'manual' ? 'Manual' : SORT_LABELS[o.sort]} ${o.dir === 'asc' ? '↑' : '↓'}`);
  if (o.group !== 'none') parts.push(`grouped by ${GROUP_LABELS[o.group].toLowerCase()}`);
  return parts.join(' · ');
}
