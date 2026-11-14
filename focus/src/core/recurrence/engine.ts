import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  fromISODate,
  makeDate,
  MONTH_SHORT,
  startOfWeek,
  weekdayIndex,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  type ISODate,
} from '../dates';
import type { RecurrenceRule } from './types';

const MAX_PERIODS = 5000;

/** Nth weekday of a month (n = -1 → last). Returns null if it does not exist. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): ISODate | null {
  const dim = daysInMonth(year, month);
  if (n === -1) {
    for (let d = dim; d > dim - 7; d--) {
      const iso = makeDate(year, month, d);
      if (weekdayIndex(iso) === weekday) return iso;
    }
    return null;
  }
  const first = makeDate(year, month, 1);
  const offset = (weekday - weekdayIndex(first) + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return day <= dim ? makeDate(year, month, day) : null;
}

function clampDay(year: number, month: number, day: number): ISODate {
  const dim = daysInMonth(year, month);
  const d = day === -1 ? dim : Math.min(day, dim);
  return makeDate(year, month, d);
}

/** Candidate dates within period k (k counts in units of `interval`). Sorted ascending. */
function candidatesInPeriod(rule: RecurrenceRule, anchor: ISODate, k: number): ISODate[] {
  const a = fromISODate(anchor);
  switch (rule.freq) {
    case 'daily': {
      const d = addDays(anchor, k * rule.interval);
      if (rule.weekdays && !rule.weekdays.includes(weekdayIndex(d))) return [];
      return [d];
    }
    case 'weekly': {
      const weekStart = addDays(startOfWeek(anchor, 1), k * rule.interval * 7);
      const days = [...(rule.weekdays ?? [weekdayIndex(anchor)])].sort((x, y) => x - y);
      return days.map((wd) => addDays(weekStart, wd));
    }
    case 'monthly': {
      const base = addMonths(makeDate(a.getFullYear(), a.getMonth() + 1, 1), k * rule.interval);
      const [ys, ms] = base.split('-');
      const y = Number(ys);
      const m = Number(ms);
      if (rule.nthWeekday) {
        const d = nthWeekdayOfMonth(y, m, rule.nthWeekday.weekday, rule.nthWeekday.n);
        return d ? [d] : [];
      }
      const days = rule.monthDays ?? [a.getDate()];
      return [...new Set(days.map((d) => clampDay(y, m, d)))].sort();
    }
    case 'yearly': {
      const y = a.getFullYear() + k * rule.interval;
      const m = rule.month ?? a.getMonth() + 1;
      if (rule.nthWeekday) {
        const d = nthWeekdayOfMonth(y, m, rule.nthWeekday.weekday, rule.nthWeekday.n);
        return d ? [d] : [];
      }
      const day = rule.monthDays?.[0] ?? a.getDate();
      return [clampDay(y, m, day)];
    }
  }
}

/** Approximate period index containing `date`, used to skip ahead quickly. */
function periodIndexFor(rule: RecurrenceRule, anchor: ISODate, date: ISODate): number {
  const days = diffDays(date, anchor);
  if (days <= 0) return 0;
  switch (rule.freq) {
    case 'daily':
      return Math.floor(days / rule.interval);
    case 'weekly':
      return Math.floor(diffDays(date, startOfWeek(anchor, 1)) / 7 / rule.interval);
    case 'monthly': {
      const a = fromISODate(anchor);
      const d = fromISODate(date);
      const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
      return Math.max(0, Math.floor(months / rule.interval));
    }
    case 'yearly':
      return Math.max(0, Math.floor((fromISODate(date).getFullYear() - fromISODate(anchor).getFullYear()) / rule.interval));
  }
}

/**
 * First occurrence of the rule strictly after `after` (and not before the anchor).
 * Returns null if the rule has ended (`until`) or no date exists.
 */
export function occurrenceAfter(rule: RecurrenceRule, anchor: ISODate, after: ISODate): ISODate | null {
  const start = Math.max(0, periodIndexFor(rule, anchor, after) - 1);
  for (let k = start; k < start + MAX_PERIODS; k++) {
    for (const c of candidatesInPeriod(rule, anchor, k)) {
      if (c > after && c >= anchor) {
        if (rule.until && c > rule.until) return null;
        return c;
      }
    }
  }
  return null;
}

/** First date ≥ `from` matching the rule's pattern, ignoring interval alignment. Used to start a new series. */
export function firstOccurrenceOnOrAfter(rule: RecurrenceRule, from: ISODate): ISODate | null {
  return occurrenceAfter({ ...rule, interval: 1, until: null }, from, addDays(from, -1));
}

export interface NextOccurrenceInput {
  rule: RecurrenceRule;
  /** The occurrence being completed. */
  scheduledDate: ISODate | null;
  completedOn: ISODate;
  today: ISODate;
}

/**
 * Next occurrence date for a completed recurring task (ADR-005).
 *  - scheduled basis: first pattern date strictly after max(scheduled date, today),
 *    aligned to the series anchor. Overdue tasks therefore jump to the future
 *    instead of generating more overdue copies.
 *  - completion basis: pattern counted from the completion day.
 */
export function nextOccurrence({ rule, scheduledDate, completedOn, today }: NextOccurrenceInput): ISODate | null {
  if (rule.basis === 'completion') {
    return occurrenceAfter(rule, completedOn, completedOn);
  }
  const anchor = rule.anchor ?? scheduledDate ?? completedOn;
  const base = scheduledDate && scheduledDate > today ? scheduledDate : today;
  return occurrenceAfter(rule, anchor, base);
}

/** Upcoming occurrence dates (for previews and the calendar). */
export function previewOccurrences(rule: RecurrenceRule, start: ISODate, count: number): ISODate[] {
  const anchor = rule.anchor ?? start;
  const out: ISODate[] = [];
  let cursor = addDays(start, -1);
  while (out.length < count) {
    const next = occurrenceAfter(rule, anchor, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function ordinal(n: number): string {
  if (n === -1) return 'last';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

const NTH_WORDS: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' };

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Plain-English description, e.g. "Every 2 weeks on Tuesday". */
export function describeRule(rule: RecurrenceRule): string {
  const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
  let text: string;
  switch (rule.freq) {
    case 'daily': {
      const wd = rule.weekdays ? [...rule.weekdays].sort() : null;
      if (wd && wd.join() === '0,1,2,3,4' && rule.interval === 1) text = 'Every weekday';
      else if (wd && wd.join() === '5,6' && rule.interval === 1) text = 'Every weekend day';
      else text = every('day') + (wd ? ` (${wd.map((d) => WEEKDAY_SHORT[d]).join(', ')})` : '');
      break;
    }
    case 'weekly': {
      const wd = rule.weekdays ? [...rule.weekdays].sort() : null;
      text = every('week') + (wd ? ` on ${joinList(wd.map((d) => WEEKDAY_NAMES[d]!))}` : '');
      break;
    }
    case 'monthly': {
      if (rule.nthWeekday) {
        text = `${every('month')} on the ${NTH_WORDS[rule.nthWeekday.n]} ${WEEKDAY_NAMES[rule.nthWeekday.weekday]}`;
      } else if (rule.monthDays) {
        text = `${every('month')} on the ${joinList(rule.monthDays.map((d) => (d === -1 ? 'last day' : ordinal(d))))}`;
      } else text = every('month');
      break;
    }
    case 'yearly': {
      const mon = rule.month ? MONTH_SHORT[rule.month - 1] : null;
      if (rule.nthWeekday && mon) {
        text = `${every('year')} on the ${NTH_WORDS[rule.nthWeekday.n]} ${WEEKDAY_NAMES[rule.nthWeekday.weekday]} of ${mon}`;
      } else if (mon && rule.monthDays?.[0]) text = `${every('year')} on ${rule.monthDays[0]} ${mon}`;
      else text = every('year');
      break;
    }
  }
  if (rule.basis === 'completion') text += ' after completion';
  if (rule.until) text += ` until ${rule.until}`;
  return text;
}
