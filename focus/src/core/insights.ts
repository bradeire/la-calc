/**
 * Reporting (Phase 4, spec 6.1–6.3). Pure functions over real task and time data:
 * every figure is derived from stored timestamps, nothing is estimated or invented.
 *
 * Definitions (shown in the UI next to each report):
 *  - Completed: status "completed" with completed_at in the range (deleted tasks excluded;
 *    a reopened task is no longer completed). Each recurring occurrence counts once.
 *  - Missed due date: a task whose due date (deadline, else scheduled date) fell in the
 *    period and that was not completed by the end of that day. Uses current dates, so a
 *    task you rescheduled counts against its new date.
 *  - Days are local calendar days of the device.
 */
import { addDays, diffDays, startOfMonth, startOfWeek, toISODate, type ISODate } from './dates';
import { occurrenceAfter } from './recurrence/engine';
import type { Priority, Task, TimeEntry } from './domain/types';

export type Granularity = 'day' | 'week' | 'month';
export interface DateRange {
  from: ISODate;
  to: ISODate;
}

/** Local calendar day of an ISO timestamp. */
export const localDay = (iso: string): ISODate => toISODate(new Date(iso));
const inRange = (d: ISODate, r: DateRange) => d >= r.from && d <= r.to;

export function bucketOf(d: ISODate, g: Granularity, weekStartsOn: 0 | 1 = 1): ISODate {
  return g === 'day' ? d : g === 'week' ? startOfWeek(d, weekStartsOn) : startOfMonth(d);
}

export function bucketsIn(r: DateRange, g: Granularity, weekStartsOn: 0 | 1 = 1): ISODate[] {
  const out: ISODate[] = [];
  let k = bucketOf(r.from, g, weekStartsOn);
  while (k <= r.to) {
    out.push(k);
    if (g === 'day') k = addDays(k, 1);
    else if (g === 'week') k = addDays(k, 7);
    else {
      const [y, m] = k.split('-').map(Number) as [number, number];
      k = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    }
  }
  return out;
}

/** Suggested granularity so charts stay readable. */
export const autoGranularity = (r: DateRange): Granularity => {
  const days = diffDays(r.from, r.to) + 1;
  return days <= 31 ? 'day' : days <= 190 ? 'week' : 'month';
};

const isCompleted = (t: Task) => t.status === 'completed' && !!t.completedAt && !t.deletedAt;
const completedIn = (t: Task, r: DateRange) => isCompleted(t) && inRange(localDay(t.completedAt!), r);
const isOpen = (t: Task) => !t.deletedAt && !['completed', 'cancelled', 'archived'].includes(t.status);
export const dueDateOf = (t: Task): ISODate | null => t.deadline ?? t.scheduledDate;

export interface CreatedCompletedPoint {
  bucket: ISODate;
  created: number;
  completed: number;
}

export function createdVsCompleted(tasks: readonly Task[], r: DateRange, g: Granularity, weekStartsOn: 0 | 1 = 1): CreatedCompletedPoint[] {
  const map = new Map(bucketsIn(r, g, weekStartsOn).map((b) => [b, { bucket: b, created: 0, completed: 0 }]));
  for (const t of tasks) {
    if (t.deletedAt) continue;
    const c = localDay(t.createdAt);
    if (inRange(c, r)) map.get(bucketOf(c, g, weekStartsOn))!.created++;
    if (completedIn(t, r)) map.get(bucketOf(localDay(t.completedAt!), g, weekStartsOn))!.completed++;
  }
  return [...map.values()];
}

export interface CountRow {
  key: string | null;
  count: number;
}
const sortCounts = (m: Map<string | null, number>): CountRow[] =>
  [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));

/** Completed tasks per project (key null = Inbox). */
export function completedByProject(tasks: readonly Task[], r: DateRange): CountRow[] {
  const m = new Map<string | null, number>();
  for (const t of tasks) if (completedIn(t, r)) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
  return sortCounts(m);
}

/** Completed tasks per label (a task with two labels counts for both; key null = no label). */
export function completedByLabel(tasks: readonly Task[], r: DateRange): CountRow[] {
  const m = new Map<string | null, number>();
  for (const t of tasks) {
    if (!completedIn(t, r)) continue;
    for (const l of t.labelIds.length ? t.labelIds : [null]) m.set(l, (m.get(l) ?? 0) + 1);
  }
  return sortCounts(m);
}

export interface PriorityRow {
  priority: Priority;
  open: number;
  completed: number;
}
/** Open tasks now, and tasks completed in the range, by priority. */
export function priorityDistribution(tasks: readonly Task[], r: DateRange): PriorityRow[] {
  const rows: PriorityRow[] = ([1, 2, 3, 4] as Priority[]).map((priority) => ({ priority, open: 0, completed: 0 }));
  for (const t of tasks) {
    if (isOpen(t)) rows[t.priority - 1]!.open++;
    else if (completedIn(t, r)) rows[t.priority - 1]!.completed++;
  }
  return rows;
}

export interface DuePoint {
  bucket: ISODate;
  due: number;
  onTime: number;
  missed: number;
}
/** Due dates in each period and how many were missed (see definitions above). */
export function dueDateTrend(tasks: readonly Task[], r: DateRange, g: Granularity, today: ISODate, weekStartsOn: 0 | 1 = 1): DuePoint[] {
  const map = new Map(bucketsIn(r, g, weekStartsOn).map((b) => [b, { bucket: b, due: 0, onTime: 0, missed: 0 }]));
  for (const t of tasks) {
    if (t.deletedAt || t.status === 'cancelled') continue;
    const due = dueDateOf(t);
    if (!due || !inRange(due, r) || due > today) continue;
    const p = map.get(bucketOf(due, g, weekStartsOn))!;
    const doneDay = isCompleted(t) ? localDay(t.completedAt!) : null;
    if (doneDay !== null && doneDay <= due) {
      p.due++;
      p.onTime++;
    } else if (doneDay !== null || due < today) {
      p.due++;
      p.missed++;
    }
    // Open and due today: not yet missed, so not counted.
  }
  return [...map.values()];
}

export interface RecurringRow {
  seriesId: string;
  title: string;
  completed: number;
  /** Occurrences the pattern called for in the range; null for "after completion" repeats. */
  expected: number | null;
}
/**
 * Recurring task completion. Expected occurrences come from the repeat pattern between the
 * series' first date and the end of the range (never beyond today).
 */
export function recurringCompletion(tasks: readonly Task[], r: DateRange, today: ISODate): RecurringRow[] {
  const series = new Map<string, Task[]>();
  for (const t of tasks) if (t.seriesId && !t.deletedAt) series.set(t.seriesId, [...(series.get(t.seriesId) ?? []), t]);
  const out: RecurringRow[] = [];
  for (const [seriesId, items] of series) {
    const withRule = items.find((t) => t.recurrence) ?? null;
    const completed = items.filter((t) => completedIn(t, r)).length;
    if (!withRule && !completed) continue;
    const latest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    let expected: number | null = null;
    const rule = withRule?.recurrence;
    if (rule && rule.basis !== 'completion') {
      const firstDates = items.map((t) => t.scheduledDate).filter((d): d is ISODate => !!d).sort();
      const start = firstDates[0] ?? localDay(items[0]!.createdAt);
      const from = start > r.from ? start : r.from;
      const to = r.to < today ? r.to : today;
      expected = 0;
      const anchor = rule.anchor ?? start;
      let d = occurrenceAfter(rule, anchor, addDays(from, -1));
      while (d && d <= to && expected < 5000) {
        expected++;
        d = occurrenceAfter(rule, anchor, d);
      }
    }
    if (expected === 0 && !completed) continue;
    out.push({ seriesId, title: latest.title, completed, expected });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export interface ProjectProgress {
  projectId: string | null;
  open: number;
  completed: number;
}
/** Current progress per project: all non-deleted, non-cancelled tasks (subtasks included). */
export function projectProgress(tasks: readonly Task[]): ProjectProgress[] {
  const m = new Map<string | null, ProjectProgress>();
  for (const t of tasks) {
    if (t.deletedAt || t.status === 'cancelled') continue;
    const p = m.get(t.projectId) ?? { projectId: t.projectId, open: 0, completed: 0 };
    if (isCompleted(t)) p.completed++;
    else if (isOpen(t)) p.open++;
    m.set(t.projectId, p);
  }
  return [...m.values()];
}

export interface Totals {
  completed: number;
  created: number;
  open: number;
  overdue: number;
  completedPerDay: number;
}
export function totals(tasks: readonly Task[], r: DateRange, today: ISODate): Totals {
  let completed = 0;
  let created = 0;
  let open = 0;
  let overdue = 0;
  for (const t of tasks) {
    if (t.deletedAt) continue;
    if (completedIn(t, r)) completed++;
    if (inRange(localDay(t.createdAt), r)) created++;
    if (isOpen(t)) {
      open++;
      const due = dueDateOf(t);
      if (due && due < today) overdue++;
    }
  }
  const end = r.to < today ? r.to : today;
  const days = Math.max(1, diffDays(r.from, end) + 1);
  return { completed, created, open, overdue, completedPerDay: Math.round((completed / days) * 10) / 10 };
}

// ---------- Time tracking ----------

/**
 * Minutes of a time entry. Running timers count only up to `now`, and are reported
 * separately: an active timer does not prove the user is working (spec 6.2).
 */
export function entryMinutes(e: TimeEntry, now: Date): number {
  if (e.minutes !== null) return e.minutes;
  return Math.max(0, Math.round((now.getTime() - Date.parse(e.startedAt)) / 60000));
}

export interface TimeReport {
  totalMinutes: number;
  runningMinutes: number;
  byDay: { day: ISODate; minutes: number }[];
  byWeek: { week: ISODate; minutes: number }[];
  byProject: { projectId: string | null; minutes: number }[];
  byTask: { taskId: string; minutes: number; estimate: number | null }[];
  /** Completed tasks in the range with an estimate and logged time. */
  estimateVsActual: { taskId: string; estimate: number; actual: number }[];
}

export function timeReport(entries: readonly TimeEntry[], tasks: readonly Task[], r: DateRange, now: Date, weekStartsOn: 0 | 1 = 1): TimeReport {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const byDay = new Map(bucketsIn(r, 'day').map((d) => [d, 0]));
  const byWeek = new Map(bucketsIn(r, 'week', weekStartsOn).map((d) => [d, 0]));
  const byProject = new Map<string | null, number>();
  const byTask = new Map<string, number>();
  const allTime = new Map<string, number>();
  let total = 0;
  let running = 0;
  for (const e of entries) {
    if (e.deletedAt) continue;
    const m = entryMinutes(e, now);
    allTime.set(e.taskId, (allTime.get(e.taskId) ?? 0) + m);
    const day = localDay(e.startedAt);
    if (!inRange(day, r)) continue;
    if (e.endedAt === null) {
      running += m;
      continue;
    }
    total += m;
    byDay.set(day, (byDay.get(day) ?? 0) + m);
    const wk = startOfWeek(day, weekStartsOn);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + m);
    const pid = taskById.get(e.taskId)?.projectId ?? null;
    byProject.set(pid, (byProject.get(pid) ?? 0) + m);
    byTask.set(e.taskId, (byTask.get(e.taskId) ?? 0) + m);
  }
  const estimateVsActual = tasks
    .filter((t) => completedIn(t, r) && t.durationMinutes && allTime.get(t.id))
    .map((t) => ({ taskId: t.id, estimate: t.durationMinutes!, actual: allTime.get(t.id)! }));
  return {
    totalMinutes: total,
    runningMinutes: running,
    byDay: [...byDay].map(([day, minutes]) => ({ day, minutes })),
    byWeek: [...byWeek].map(([week, minutes]) => ({ week, minutes })),
    byProject: [...byProject].map(([projectId, minutes]) => ({ projectId, minutes })).sort((a, b) => b.minutes - a.minutes),
    byTask: [...byTask]
      .map(([taskId, minutes]) => ({ taskId, minutes, estimate: taskById.get(taskId)?.durationMinutes ?? null }))
      .sort((a, b) => b.minutes - a.minutes),
    estimateVsActual,
  };
}

/** Timers left running longer than this are flagged for the user to confirm or trim. */
export const LONG_TIMER_MINUTES = 4 * 60;
