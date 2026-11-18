import { addDays, addMonths, endOfMonth, isValidYMD, makeDate, startOfMonth, startOfWeek, type ISODate } from '../dates';
import { isOpenStatus, type Task } from '../domain/types';
import type { Condition, DateField, Rule } from './types';

export interface FilterContext {
  today: ISODate;
  weekStartsOn: 0 | 1;
  /** projectId → that project and all its descendants. */
  projectTree: Map<string, Set<string>>;
  /** Tasks with an unfinished prerequisite. */
  blocked: Set<string>;
  /** Tasks that other open tasks depend on. */
  blocking: Set<string>;
}

/** Resolve a single date expression: today, tomorrow, yesterday, ±N(d|w|m), YYYY-MM-DD, DD/MM/YYYY. */
export function resolveDateExpr(expr: string, today: ISODate): ISODate | null {
  const e = expr.trim().toLowerCase();
  if (e === 'today') return today;
  if (e === 'tomorrow') return addDays(today, 1);
  if (e === 'yesterday') return addDays(today, -1);
  let m = /^([+-])(\d{1,4})([dwm])$/.exec(e);
  if (m) {
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    return m[3] === 'd' ? addDays(today, n) : m[3] === 'w' ? addDays(today, n * 7) : addMonths(today, n);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e);
  if (m) return isValidYMD(+m[1]!, +m[2]!, +m[3]!) ? e : null;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(e);
  if (m) return isValidYMD(+m[3]!, +m[2]!, +m[1]!) ? makeDate(+m[3]!, +m[2]!, +m[1]!) : null;
  return null;
}

/** Named ranges usable with `on`: this-week, next-week, last-week, this-month, next-month, next-N-days, last-N-days. */
export function resolveRange(expr: string, today: ISODate, weekStartsOn: 0 | 1): [ISODate, ISODate] | null {
  const e = expr.trim().toLowerCase();
  const wk = startOfWeek(today, weekStartsOn);
  if (e === 'this-week') return [wk, addDays(wk, 6)];
  if (e === 'next-week') return [addDays(wk, 7), addDays(wk, 13)];
  if (e === 'last-week') return [addDays(wk, -7), addDays(wk, -1)];
  if (e === 'this-month') return [startOfMonth(today), endOfMonth(today)];
  if (e === 'next-month') {
    const s = addMonths(startOfMonth(today), 1);
    return [s, endOfMonth(s)];
  }
  let m = /^next-(\d{1,3})-days$/.exec(e);
  if (m) return [today, addDays(today, Number(m[1]) - 1)];
  m = /^last-(\d{1,3})-days$/.exec(e);
  if (m) return [addDays(today, -Number(m[1]) + 1), today];
  const single = resolveDateExpr(e, today);
  return single ? [single, single] : null;
}

function dateValue(task: Task, field: Exclude<DateField, 'due'>): ISODate | null {
  switch (field) {
    case 'scheduled': return task.scheduledDate;
    case 'deadline': return task.deadline;
    case 'start': return task.startDate;
    case 'completed': return task.completedAt ? isoLocal(task.completedAt) : null;
    case 'created': return isoLocal(task.createdAt);
  }
}

const isoLocal = (utc: string) => {
  const d = new Date(utc);
  return makeDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

function matchDate(d: ISODate | null, rule: Extract<Rule, { field: DateField }>, ctx: FilterContext): boolean {
  const { op } = rule;
  if (op === 'none') return d === null;
  if (op === 'any') return d !== null;
  if (d === null) return false;
  if (op === 'overdue') return d < ctx.today;
  if (op === 'on') {
    const r = resolveRange(rule.value ?? '', ctx.today, ctx.weekStartsOn);
    return !!r && d >= r[0] && d <= r[1];
  }
  if (op === 'between') {
    const a = resolveDateExpr(rule.value ?? '', ctx.today);
    const b = resolveDateExpr(rule.value2 ?? '', ctx.today);
    return !!a && !!b && d >= a && d <= b;
  }
  const v = resolveDateExpr(rule.value ?? '', ctx.today);
  if (!v) return false;
  switch (op) {
    case 'before': return d < v;
    case 'after': return d > v;
    case 'onOrBefore': return d <= v;
    case 'onOrAfter': return d >= v;
  }
}

function cmp(a: number, op: string, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

function matchRule(rule: Rule, t: Task, ctx: FilterContext): boolean {
  switch (rule.field) {
    case 'priority':
      return cmp(t.priority, rule.op, rule.value);
    case 'status':
      return rule.op === 'is' ? rule.value.includes(t.status) : !rule.value.includes(t.status);
    case 'project': {
      const hit = rule.value.some((p) => (p === 'inbox' ? t.projectId === null : !!t.projectId && (ctx.projectTree.get(p)?.has(t.projectId) ?? p === t.projectId)));
      return rule.op === 'in' ? hit : !hit;
    }
    case 'label':
      if (rule.op === 'hasAny') return rule.value.some((l) => t.labelIds.includes(l));
      if (rule.op === 'hasAll') return rule.value.every((l) => t.labelIds.includes(l));
      return rule.value.length === 0 ? t.labelIds.length === 0 : !rule.value.some((l) => t.labelIds.includes(l));
    case 'duration':
      if (rule.op === 'none') return t.durationMinutes === null;
      if (rule.op === 'any') return t.durationMinutes !== null;
      return t.durationMinutes !== null && cmp(t.durationMinutes, rule.op, rule.value ?? 0);
    case 'text': {
      const q = rule.value.toLowerCase();
      return t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    }
    case 'dependency':
      if (rule.op === 'blocked') return ctx.blocked.has(t.id);
      if (rule.op === 'blocking') return ctx.blocking.has(t.id);
      return !ctx.blocked.has(t.id) && !ctx.blocking.has(t.id);
    case 'recurring':
      return (t.recurrence !== null) === (rule.op === 'yes');
    case 'subtask':
      return (t.parentId !== null) === (rule.op === 'yes');
    case 'due': {
      // "Due" = scheduled or deadline. Overdue/none consider both.
      if (rule.op === 'none') return t.scheduledDate === null && t.deadline === null;
      return matchDate(t.scheduledDate, rule, ctx) || matchDate(t.deadline, rule, ctx);
    }
    default:
      return matchDate(dateValue(t, rule.field), rule, ctx);
  }
}

export function evaluate(c: Condition, t: Task, ctx: FilterContext): boolean {
  if (c.kind === 'not') return !evaluate(c.child, t, ctx);
  if (c.kind === 'group') {
    const r = c.op === 'and' ? c.children.every((x) => evaluate(x, t, ctx)) : c.children.some((x) => evaluate(x, t, ctx));
    return c.not ? !r : r;
  }
  return matchRule(c, t, ctx);
}

/** Whether the filter itself talks about status/completion; otherwise only open tasks are shown. */
export function mentionsClosedTasks(c: Condition): boolean {
  if (c.kind === 'not') return mentionsClosedTasks(c.child);
  if (c.kind === 'group') return c.children.some(mentionsClosedTasks);
  return c.field === 'status' || c.field === 'completed';
}

/** Apply a filter to tasks: excludes deleted tasks, and closed tasks unless the filter mentions status. */
export function applyFilter(root: Condition, tasks: readonly Task[], ctx: FilterContext): Task[] {
  const includeClosed = mentionsClosedTasks(root);
  return tasks.filter((t) => !t.deletedAt && (includeClosed || isOpenStatus(t.status)) && evaluate(root, t, ctx));
}
