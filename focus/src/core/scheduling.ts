/**
 * Scheduling engine (spec 4.2–4.3). Pure functions over tasks: capacity from
 * working hours, per-day workload, conflict detection and *suggested* moves.
 * Nothing here changes data — the user accepts or rejects each suggestion.
 */
import { addDays, compareISO, diffDays, weekdayIndex, type ISODate } from './dates';
import type { DependencyEdge, Task } from './domain/types';

export interface WorkingHours {
  /** 0 = Monday … 6 = Sunday */
  days: number[];
  start: string;
  end: string;
}

export interface SchedulingOptions {
  today: ISODate;
  hours: WorkingHours;
  /** Minutes assumed for tasks without an estimate, for load purposes only. */
  defaultEstimate: number;
  horizonDays: number;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function capacityFor(date: ISODate, hours: WorkingHours): number {
  if (!hours.days.includes(weekdayIndex(date))) return 0;
  return Math.max(0, toMin(hours.end) - toMin(hours.start));
}

export interface DayLoad {
  date: ISODate;
  capacity: number;
  /** Minutes from tasks with estimates. */
  estimated: number;
  /** Tasks without an estimate (counted at defaultEstimate in `planned`). */
  unestimated: number;
  planned: number;
  taskIds: string[];
  overloaded: boolean;
}

export function workload(tasks: readonly Task[], from: ISODate, to: ISODate, o: Pick<SchedulingOptions, 'hours' | 'defaultEstimate'>): DayLoad[] {
  const days: DayLoad[] = [];
  const byDate = new Map<ISODate, DayLoad>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const load: DayLoad = { date: d, capacity: capacityFor(d, o.hours), estimated: 0, unestimated: 0, planned: 0, taskIds: [], overloaded: false };
    days.push(load);
    byDate.set(d, load);
  }
  for (const t of tasks) {
    const day = t.scheduledDate ? byDate.get(t.scheduledDate) : undefined;
    if (!day) continue;
    day.taskIds.push(t.id);
    if (t.durationMinutes) day.estimated += t.durationMinutes;
    else day.unestimated++;
  }
  for (const d of days) {
    d.planned = d.estimated + d.unestimated * o.defaultEstimate;
    // Days without working hours (e.g. weekends) hold deliberately planned personal tasks; they are not "overloaded".
    d.overloaded = d.capacity > 0 && d.planned > d.capacity;
  }
  return days;
}

export type Conflict =
  | { kind: 'overloaded'; date: ISODate; planned: number; capacity: number }
  | { kind: 'overlap'; date: ISODate; taskIds: [string, string] }
  | { kind: 'afterDeadline'; taskId: string }
  | { kind: 'beforeStart'; taskId: string }
  | { kind: 'dependencyOrder'; taskId: string; prerequisiteId: string }
  | { kind: 'deadlineAtRisk'; taskId: string; needed: number; available: number }
  | { kind: 'overdue'; taskIds: string[]; minutes: number };

export interface Suggestion {
  /** Stable key so a rejected suggestion stays hidden. */
  key: string;
  taskId: string;
  from: ISODate | null;
  to: ISODate;
  reason: string;
}

const est = (t: Task, o: SchedulingOptions) => t.durationMinutes ?? o.defaultEstimate;

function prerequisiteMap(edges: readonly DependencyEdge[]) {
  const pre = new Map<string, string[]>();
  const dep = new Map<string, string[]>();
  for (const e of edges) {
    pre.set(e.taskId, [...(pre.get(e.taskId) ?? []), e.dependsOnId]);
    dep.set(e.dependsOnId, [...(dep.get(e.dependsOnId) ?? []), e.taskId]);
  }
  return { pre, dep };
}

export function findConflicts(openTasks: readonly Task[], edges: readonly DependencyEdge[], o: SchedulingOptions): Conflict[] {
  const out: Conflict[] = [];
  const byId = new Map(openTasks.map((t) => [t.id, t]));
  const horizonEnd = addDays(o.today, o.horizonDays - 1);

  const overdue = openTasks.filter((t) => t.scheduledDate && t.scheduledDate < o.today);
  if (overdue.length) out.push({ kind: 'overdue', taskIds: overdue.map((t) => t.id), minutes: overdue.reduce((s, t) => s + est(t, o), 0) });

  for (const d of workload(openTasks, o.today, horizonEnd, o)) {
    if (d.overloaded) out.push({ kind: 'overloaded', date: d.date, planned: d.planned, capacity: d.capacity });
  }

  // Overlapping time blocks on the same day.
  const timed = openTasks.filter((t) => t.scheduledDate && t.scheduledTime && t.scheduledDate >= o.today);
  const byDay = new Map<string, Task[]>();
  for (const t of timed) byDay.set(t.scheduledDate!, [...(byDay.get(t.scheduledDate!) ?? []), t]);
  for (const [date, list] of byDay) {
    const sorted = [...list].sort((a, b) => toMin(a.scheduledTime!) - toMin(b.scheduledTime!));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (toMin(b.scheduledTime!) < toMin(a.scheduledTime!) + est(a, o)) out.push({ kind: 'overlap', date, taskIds: [a.id, b.id] });
        else break;
      }
    }
  }

  for (const t of openTasks) {
    if (t.scheduledDate && t.deadline && t.scheduledDate > t.deadline) out.push({ kind: 'afterDeadline', taskId: t.id });
    if (t.scheduledDate && t.startDate && t.scheduledDate < t.startDate) out.push({ kind: 'beforeStart', taskId: t.id });
  }

  const { pre } = prerequisiteMap(edges);
  for (const [taskId, preIds] of pre) {
    const t = byId.get(taskId);
    if (!t?.scheduledDate) continue;
    for (const pid of preIds) {
      const p = byId.get(pid);
      const pDate = p?.scheduledDate ?? p?.deadline;
      if (p && pDate && pDate > t.scheduledDate) out.push({ kind: 'dependencyOrder', taskId, prerequisiteId: pid });
    }
  }

  // Deadlines at risk: earliest-deadline-first over remaining capacity (counts all planned work before it).
  const withDeadline = openTasks.filter((t) => t.deadline && t.deadline >= o.today && t.deadline <= horizonEnd).sort((a, b) => compareISO(a.deadline, b.deadline));
  for (const t of withDeadline) {
    let available = 0;
    for (let d = o.today; d <= t.deadline!; d = addDays(d, 1)) available += capacityFor(d, o.hours);
    const needed = openTasks
      .filter((x) => (x.deadline && x.deadline <= t.deadline!) || (x.scheduledDate && x.scheduledDate >= o.today && x.scheduledDate <= t.deadline!))
      .reduce((s, x) => s + est(x, o), 0);
    if (needed > available) out.push({ kind: 'deadlineAtRisk', taskId: t.id, needed, available });
  }
  return out;
}

/**
 * Suggest moves that relieve overload, place overdue work, and schedule
 * deadline work — never moving fixed-time tasks, never past a deadline when
 * avoidable, never before a start date or an unfinished prerequisite.
 */
export function suggestSchedule(openTasks: readonly Task[], edges: readonly DependencyEdge[], o: SchedulingOptions): Suggestion[] {
  const horizonEnd = addDays(o.today, o.horizonDays - 1);
  const loads = new Map(workload(openTasks, o.today, horizonEnd, o).map((d) => [d.date, d]));
  const byId = new Map(openTasks.map((t) => [t.id, t]));
  const { pre, dep } = prerequisiteMap(edges);
  const planned = new Map<string, ISODate>(); // proposed dates, so later choices respect earlier ones
  const dateOf = (id: string) => planned.get(id) ?? byId.get(id)?.scheduledDate ?? null;
  const out: Suggestion[] = [];

  const earliestAllowed = (t: Task): ISODate => {
    let d = o.today;
    if (t.startDate && t.startDate > d) d = t.startDate;
    for (const pid of pre.get(t.id) ?? []) {
      const pd = dateOf(pid);
      if (byId.has(pid) && pd && pd > d) d = pd;
    }
    return d;
  };
  const latestAllowed = (t: Task): ISODate | null => {
    let d: ISODate | null = t.deadline;
    for (const did of dep.get(t.id) ?? []) {
      const dd = dateOf(did);
      if (byId.has(did) && dd && (!d || dd < d)) d = dd;
    }
    return d;
  };
  /** First day with room, on or after the earliest allowed date (and after `after`, if given). */
  const findDay = (t: Task, after?: ISODate): { date: ISODate; late: boolean } | null => {
    const need = est(t, o);
    let from = earliestAllowed(t);
    if (after && addDays(after, 1) > from) from = addDays(after, 1);
    const latest = latestAllowed(t);
    for (let d = from; d <= horizonEnd; d = addDays(d, 1)) {
      const l = loads.get(d);
      if (!l || l.capacity === 0) continue;
      if (l.planned + need <= l.capacity) return { date: d, late: !!latest && d > latest };
    }
    return null;
  };
  const place = (t: Task, to: ISODate, reason: string) => {
    const from = dateOf(t.id);
    if (from && loads.get(from)) {
      const l = loads.get(from)!;
      l.planned -= est(t, o);
    }
    loads.get(to)!.planned += est(t, o);
    planned.set(t.id, to);
    out.push({ key: `${t.id}:${to}`, taskId: t.id, from: t.scheduledDate, to, reason });
  };
  const fmtLate = (late: boolean) => (late ? ' — no free time before the deadline' : '');

  // 1. Overdue work, most important first.
  const overdue = openTasks
    .filter((t) => t.scheduledDate && t.scheduledDate < o.today && !t.scheduledTime)
    .sort((a, b) => a.priority - b.priority || compareISO(a.deadline, b.deadline));
  for (const t of overdue) {
    const slot = findDay(t);
    if (slot) place(t, slot.date, `Overdue by ${diffDays(o.today, t.scheduledDate!)} day${diffDays(o.today, t.scheduledDate!) === 1 ? '' : 's'}${fmtLate(slot.late)}`);
  }

  // 2. Relieve overloaded days by moving the least important flexible tasks later.
  for (const day of [...loads.values()]) {
    if (day.capacity === 0 || day.planned <= day.capacity) continue;
    const movable = openTasks
      .filter((t) => dateOf(t.id) === day.date && !t.scheduledTime && t.deadline !== day.date)
      // Least important first; among equals prefer tasks without deadlines, then the smallest move.
      .sort((a, b) => b.priority - a.priority || (a.deadline ? 1 : 0) - (b.deadline ? 1 : 0) || est(a, o) - est(b, o));
    for (const t of movable) {
      if (day.planned <= day.capacity) break;
      const slot = findDay(t, day.date);
      if (slot && !slot.late) {
        place(t, slot.date, `That day is ${Math.round(day.planned - day.capacity)} min over capacity; this P${t.priority} task is flexible`);
      }
    }
  }

  // 3. Unscheduled work whose deadline is within a week (further-off deadlines are left to the user).
  const soon = addDays(o.today, 7);
  const unscheduled = openTasks
    .filter((t) => !t.scheduledDate && t.deadline && t.deadline <= soon)
    .sort((a, b) => compareISO(a.deadline, b.deadline) || a.priority - b.priority);
  for (const t of unscheduled) {
    const slot = findDay(t);
    if (slot) place(t, slot.date, `${t.deadline! < o.today ? 'Deadline has passed' : `Due in ${diffDays(t.deadline!, o.today)} day${diffDays(t.deadline!, o.today) === 1 ? '' : 's'}`} with no planned time${fmtLate(slot.late)}`);
  }

  // 4. Dependants planned before their prerequisite.
  for (const [taskId, preIds] of pre) {
    const t = byId.get(taskId);
    const td = dateOf(taskId);
    if (!t || !td || t.scheduledTime) continue;
    const blocking = preIds.map(dateOf).filter((d): d is ISODate => !!d && d > td);
    if (blocking.length) {
      const slot = findDay(t);
      if (slot) place(t, slot.date, 'Planned before a task it depends on');
    }
  }
  return out;
}
