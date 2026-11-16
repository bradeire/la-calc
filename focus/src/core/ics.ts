/**
 * iCalendar (RFC 5545) import and export via ical.js (MPL-2.0).
 *
 * Import: Google, Outlook and Apple calendars all publish a private ".ics" address and
 * export .ics files, so one parser covers all three without signing in to anything.
 * Repeating events are expanded into concrete occurrences inside a window; moved or
 * cancelled single occurrences (RECURRENCE-ID / EXDATE / STATUS:CANCELLED) are honoured.
 *
 * Export: tasks with a scheduled date become events (all-day, or timed in floating
 * local time so they appear at the same clock time in the receiving calendar).
 */
import ICAL from 'ical.js';
import { addDays, type ISODate } from './dates';
import type { Task } from './domain/types';

export interface ExternalEvent {
  uid: string;
  title: string;
  location: string;
  allDay: boolean;
  /** All-day: YYYY-MM-DD. Timed: ISO UTC timestamp. */
  start: string;
  /** Exclusive end, same format as start. */
  end: string;
}

export const MAX_OCCURRENCES_PER_EVENT = 1000;
export const MAX_EVENTS = 20000;

export class IcsError extends Error {}

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (t: ICAL.Time): ISODate => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

/** Parse calendar text and return occurrences overlapping [from, to). */
export function parseIcs(text: string, window: { from: Date; to: Date }): ExternalEvent[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (err) {
    throw new IcsError(`This isn’t a readable calendar file (${err instanceof Error ? err.message : 'parse error'})`);
  }
  if (root.name !== 'vcalendar') throw new IcsError('This isn’t a calendar file (no VCALENDAR)');
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      // A malformed time zone: times in it are treated as local (floating).
    }
  }
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const out: ExternalEvent[] = [];

  const push = (ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null) => {
    if (out.length >= MAX_EVENTS) return;
    const allDay = start.isDate;
    let e = end;
    if (!e || e.compare(start) <= 0) {
      e = start.clone();
      if (allDay) e.day += 1;
    }
    const s = allDay ? Date.parse(`${dateOf(start)}T00:00:00`) : start.toJSDate().getTime();
    const en = allDay ? Date.parse(`${dateOf(e)}T00:00:00`) : e.toJSDate().getTime();
    if (en <= fromMs || s >= toMs) return;
    out.push({
      uid: ev.uid || '',
      title: ev.summary || '(No title)',
      location: ev.location || '',
      allDay,
      start: allDay ? dateOf(start) : new Date(s).toISOString(),
      end: allDay ? dateOf(e) : new Date(en).toISOString(),
    });
  };

  for (const comp of root.getAllSubcomponents('vevent')) {
    let ev: ICAL.Event;
    try {
      ev = new ICAL.Event(comp);
    } catch {
      continue;
    }
    // Exceptions are expanded through their master event.
    if (ev.isRecurrenceException()) continue;
    if (String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') continue;
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    for (let i = 0; i < MAX_OCCURRENCES_PER_EVENT * 5; i++) {
      const next = it.next();
      if (!next) break;
      const occStart = next.isDate ? Date.parse(`${dateOf(next)}T00:00:00`) : next.toJSDate().getTime();
      if (occStart >= toMs) break;
      const d = ev.getOccurrenceDetails(next);
      const item = d.item;
      if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') continue;
      push(item, d.startDate, d.endDate);
      if (out.length >= MAX_EVENTS) break;
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Busy minutes per local date inside working hours (all-day events don't block time). */
export function busyMinutesByDay(events: readonly ExternalEvent[], hours: { start: string; end: string }, from: ISODate, to: ISODate): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  const [sh, sm] = hours.start.split(':').map(Number) as [number, number];
  const [eh, em] = hours.end.split(':').map(Number) as [number, number];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    const ws = new Date(y, m - 1, day, sh, sm).getTime();
    const we = new Date(y, m - 1, day, eh, em).getTime();
    // Merge overlapping events so double-booked time isn't counted twice.
    const spans = events
      .filter((e) => !e.allDay)
      .map((e) => [Math.max(ws, Date.parse(e.start)), Math.min(we, Date.parse(e.end))] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curS = -1;
    let curE = -1;
    for (const [a, b] of spans) {
      if (a > curE) {
        if (curE > curS) total += curE - curS;
        curS = a;
        curE = b;
      } else curE = Math.max(curE, b);
    }
    if (curE > curS) total += curE - curS;
    if (total > 0) out.set(d, Math.round(total / 60000));
  }
  return out;
}

/** Events overlapping a task's time slot on its scheduled day. */
export function overlappingEvents(task: Pick<Task, 'scheduledDate' | 'scheduledTime' | 'durationMinutes'>, events: readonly ExternalEvent[], defaultMinutes = 30): ExternalEvent[] {
  if (!task.scheduledDate || !task.scheduledTime) return [];
  const [y, m, d] = task.scheduledDate.split('-').map(Number) as [number, number, number];
  const [h, mi] = task.scheduledTime.split(':').map(Number) as [number, number];
  const s = new Date(y, m - 1, d, h, mi).getTime();
  const e = s + (task.durationMinutes ?? defaultMinutes) * 60000;
  return events.filter((ev) => !ev.allDay && Date.parse(ev.start) < e && Date.parse(ev.end) > s);
}

// ---------- Export ----------

const floating = (date: ISODate, time: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return ICAL.Time.fromData({ year: y, month: m, day: d, hour: h, minute: mi, second: 0, isDate: false });
};
const allDay = (date: ISODate) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ICAL.Time.fromData({ year: y, month: m, day: d, isDate: true });
};

/** Tasks with a scheduled date as an .ics calendar. Tasks without one are skipped. */
export function buildIcs(tasks: readonly Task[], opts: { name: string; defaultMinutes: number; now?: Date }): string {
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.updatePropertyWithValue('prodid', '-//Focus//Focus tasks//EN');
  cal.updatePropertyWithValue('version', '2.0');
  cal.updatePropertyWithValue('calscale', 'GREGORIAN');
  cal.updatePropertyWithValue('x-wr-calname', opts.name);
  const stamp = ICAL.Time.fromJSDate(opts.now ?? new Date(), true);
  for (const t of tasks) {
    if (!t.scheduledDate || t.deletedAt) continue;
    const ev = new ICAL.Component('vevent');
    ev.updatePropertyWithValue('uid', `${t.id}@focus.local`);
    ev.updatePropertyWithValue('dtstamp', stamp);
    ev.updatePropertyWithValue('summary', t.title);
    if (t.description) ev.updatePropertyWithValue('description', t.description);
    if (t.scheduledTime) {
      ev.updatePropertyWithValue('dtstart', floating(t.scheduledDate, t.scheduledTime));
      ev.updatePropertyWithValue('duration', ICAL.Duration.fromSeconds((t.durationMinutes ?? opts.defaultMinutes) * 60));
    } else {
      ev.updatePropertyWithValue('dtstart', allDay(t.scheduledDate));
      ev.updatePropertyWithValue('dtend', allDay(addDays(t.scheduledDate, 1)));
    }
    if (t.status === 'completed') ev.updatePropertyWithValue('status', 'CONFIRMED');
    if (t.deadline) ev.updatePropertyWithValue('x-focus-deadline', t.deadline);
    cal.addSubcomponent(ev);
  }
  return cal.toString().replace(/\r?\n/g, '\r\n') + '\r\n';
}
