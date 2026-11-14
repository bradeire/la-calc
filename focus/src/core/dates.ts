/**
 * Floating calendar-date helpers. A "date" in Focus is a local calendar day
 * stored as YYYY-MM-DD (ADR-004). These helpers never go through UTC, so a
 * date cannot shift by a day across time zones or DST changes.
 */

export type ISODate = string;

export interface DatePrefs {
  /** 'dmy' (UK default), 'mdy' (US) or 'ymd' (ISO). */
  dateOrder: 'dmy' | 'mdy' | 'ymd';
  /** 24-hour clock (UK default) or 12-hour. */
  hour12: boolean;
  /** 1 = Monday (UK default), 0 = Sunday. */
  weekStartsOn: 0 | 1;
}

export const UK_PREFS: DatePrefs = { dateOrder: 'dmy', hour12: false, weekStartsOn: 1 };

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a local-midnight Date. Throws on malformed input. */
export function fromISODate(s: ISODate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** Days in month, m is 1–12. */
export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

export function makeDate(y: number, m: number, d: number): ISODate {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Add months, clamping to the end of the month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(s: ISODate, n: number): ISODate {
  const d = fromISODate(s);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const dim = daysInMonth(target.getFullYear(), target.getMonth() + 1);
  target.setDate(Math.min(day, dim));
  return toISODate(target);
}

export function addYears(s: ISODate, n: number): ISODate {
  return addMonths(s, n * 12);
}

export function diffDays(a: ISODate, b: ISODate): number {
  // Use UTC of the calendar components to avoid DST-length days.
  const pa = fromISODate(a);
  const pb = fromISODate(b);
  const ua = Date.UTC(pa.getFullYear(), pa.getMonth(), pa.getDate());
  const ub = Date.UTC(pb.getFullYear(), pb.getMonth(), pb.getDate());
  return Math.round((ua - ub) / 86400000);
}

/** ISO weekday: 0 = Monday … 6 = Sunday. */
export function weekdayIndex(s: ISODate): number {
  return (fromISODate(s).getDay() + 6) % 7;
}

export function startOfWeek(s: ISODate, weekStartsOn: 0 | 1 = 1): ISODate {
  const jsDay = fromISODate(s).getDay(); // 0 = Sunday
  const back = (jsDay - weekStartsOn + 7) % 7;
  return addDays(s, -back);
}

export function startOfMonth(s: ISODate): ISODate {
  return s.slice(0, 8) + '01';
}

export function endOfMonth(s: ISODate): ISODate {
  const d = fromISODate(s);
  return makeDate(d.getFullYear(), d.getMonth() + 1, daysInMonth(d.getFullYear(), d.getMonth() + 1));
}

export function compareISO(a: ISODate | null, b: ISODate | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

export function formatTime(t: string, prefs: DatePrefs = UK_PREFS): string {
  if (!prefs.hour12) return t;
  const [hs, ms] = t.split(':');
  const h = Number(hs);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return ms === '00' ? `${h12}${suffix}` : `${h12}:${ms}${suffix}`;
}

export function formatNumericDate(s: ISODate, prefs: DatePrefs = UK_PREFS): string {
  const [y, m, d] = s.split('-');
  if (prefs.dateOrder === 'ymd') return s;
  if (prefs.dateOrder === 'mdy') return `${m}/${d}/${y}`;
  return `${d}/${m}/${y}`;
}

/**
 * Human-friendly relative date: "Today", "Tomorrow", "Yesterday", weekday
 * within the next 6 days, "14 Nov" this year, "14 Nov 2027" otherwise.
 */
export function formatRelativeDate(s: ISODate, today: ISODate = todayISO(), prefs: DatePrefs = UK_PREFS): string {
  const delta = diffDays(s, today);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  const d = fromISODate(s);
  if (delta > 1 && delta < 7) return WEEKDAY_NAMES[weekdayIndex(s)]!;
  const day = d.getDate();
  const mon = MONTH_SHORT[d.getMonth()]!;
  const sameYear = s.slice(0, 4) === today.slice(0, 4);
  const core = prefs.dateOrder === 'mdy' ? `${mon} ${day}` : `${day} ${mon}`;
  return sameYear ? core : `${core} ${d.getFullYear()}`;
}

export function formatLongDate(s: ISODate, prefs: DatePrefs = UK_PREFS): string {
  const d = fromISODate(s);
  const wd = WEEKDAY_NAMES[weekdayIndex(s)]!;
  const mon = MONTH_NAMES[d.getMonth()]!;
  return prefs.dateOrder === 'mdy'
    ? `${wd}, ${mon} ${d.getDate()}, ${d.getFullYear()}`
    : `${wd} ${d.getDate()} ${mon} ${d.getFullYear()}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function nowUTC(): string {
  return new Date().toISOString();
}
