/**
 * Deterministic, offline natural-language parser for Quick Add (ADR-006).
 *
 * Strategy: an ordered list of matchers runs over a working copy of the input.
 * Each accepted match is "masked" (replaced by spaces of equal length) so later
 * matchers cannot reuse it, and original character offsets stay stable. Those
 * offsets identify tokens, so the UI can highlight them and the user can tap a
 * token to switch it off (it then stays part of the title).
 */
import {
  addDays,
  addMonths,
  addYears,
  endOfMonth,
  formatRelativeDate,
  isValidYMD,
  makeDate,
  MONTH_NAMES,
  startOfWeek,
  todayISO,
  weekdayIndex,
  WEEKDAY_NAMES,
  UK_PREFS,
  type DatePrefs,
  type ISODate,
} from '../dates';
import type { Priority } from '../domain/types';
import { describeRule, firstOccurrenceOnOrAfter } from '../recurrence/engine';
import type { RecurrenceRule } from '../recurrence/types';

export type TokenKind = 'date' | 'time' | 'deadline' | 'start' | 'duration' | 'recurrence' | 'priority' | 'project' | 'label';

export interface ParsedToken {
  /** Stable identity: kind + start offset in the original text. */
  key: string;
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
}

export interface Ambiguity {
  key: string;
  message: string;
  options: string[];
  selected: number;
}

export interface EntityRef {
  id: string | null;
  name: string;
  isNew: boolean;
}

export interface ParseResult {
  title: string;
  scheduledDate: ISODate | null;
  scheduledTime: string | null;
  deadline: ISODate | null;
  startDate: ISODate | null;
  durationMinutes: number | null;
  priority: Priority | null;
  project: EntityRef | null;
  labels: EntityRef[];
  recurrence: RecurrenceRule | null;
  recurrenceText: string | null;
  tokens: ParsedToken[];
  ambiguities: Ambiguity[];
}

export interface ParseContext {
  now?: Date;
  prefs?: DatePrefs;
  projects?: { id: string; name: string }[];
  labels?: { id: string; name: string }[];
  /** Token keys the user has switched off. */
  disabled?: ReadonlySet<string>;
  /** Selected option index per ambiguity key. */
  choices?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WD_FULL = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const WD_ANY = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM = `\\d+|${Object.keys(NUM_WORDS).join('|')}`;
const ORD_WORDS: Record<string, number> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, other: 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1,
};
const ORD = Object.keys(ORD_WORDS).join('|');
const ORD_SUFFIX = '(?:st|nd|rd|th)?';

function monthIndex(s: string): number {
  const k = s.slice(0, 3).toLowerCase();
  return MONTH_NAMES.findIndex((m) => m.slice(0, 3).toLowerCase() === k) + 1;
}

function weekdayFromWord(s: string): number {
  const k = s.slice(0, 2).toLowerCase();
  const map: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
  const v = map[k];
  if (v === undefined) throw new Error(`Unknown weekday ${s}`);
  return v;
}

function toNumber(s: string): number {
  const n = NUM_WORDS[s.toLowerCase()];
  return n ?? Number(s);
}

/** Date-expression source used inside larger patterns (no capture groups). */
function dateSource(looseWeekdays: boolean): string {
  const wd = looseWeekdays
    ? `(?:(?:next|this|coming)\\s+)?(?:${WD_ANY})`
    : `(?:(?:next|this|coming|on)\\s+(?:${WD_ANY}))|(?:${WD_FULL})`;
  return [
    'today|tonight|this\\s+evening|tomorrow|tmrw|tmr',
    'next\\s+week|next\\s+month|next\\s+year',
    '(?:this\\s+|next\\s+)?weekend',
    'end\\s+of\\s+(?:the\\s+)?(?:month|week)',
    `in\\s+(?:${NUM})\\s+(?:days?|weeks?|months?|years?)`,
    `\\d{1,2}${ORD_SUFFIX}(?:\\s+of)?\\s+(?:${MONTH})(?:,?\\s+\\d{4})?`,
    `(?:${MONTH})\\s+\\d{1,2}${ORD_SUFFIX}(?:,?\\s+\\d{4})?`,
    '\\d{4}-\\d{1,2}-\\d{1,2}',
    '\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?',
    '\\d{1,2}[.-]\\d{1,2}[.-](?:\\d{4}|\\d{2})',
    `${looseWeekdays ? '(?:on\\s+)?' : 'on\\s+'}the\\s+\\d{1,2}${ORD_SUFFIX}`,
    wd,
  ]
    .map((s) => `(?:${s})`)
    .join('|');
}
const DATE_STRICT = dateSource(false);
const DATE_LOOSE = dateSource(true);

interface DateResolution {
  date: ISODate;
  ambiguity?: { message: string; options: { label: string; date: ISODate }[] };
}

/** Resolve a date phrase (already isolated) to a calendar date. */
export function resolveDate(raw: string, today: ISODate, prefs: DatePrefs = UK_PREFS): DateResolution | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^on /, '');
  let m: RegExpExecArray | null;

  if (/^(today|tonight|this evening)$/.test(s)) return { date: today };
  if (/^(tomorrow|tmrw|tmr)$/.test(s)) return { date: addDays(today, 1) };
  if (s === 'next week') return { date: addDays(startOfWeek(today, prefs.weekStartsOn), 7) };
  if (s === 'next month') return { date: addMonths(today.slice(0, 8) + '01', 1) };
  if (s === 'next year') return { date: `${Number(today.slice(0, 4)) + 1}-01-01` };
  if (/^(this )?weekend$/.test(s)) {
    const wd = weekdayIndex(today);
    return { date: wd >= 5 ? today : addDays(today, 5 - wd) };
  }
  if (s === 'next weekend') {
    const wd = weekdayIndex(today);
    return { date: addDays(today, 5 - wd + 7) };
  }
  if ((m = /^end of (?:the )?(month|week)$/.exec(s))) {
    if (m[1] === 'month') return { date: endOfMonth(today) };
    const wd = weekdayIndex(today);
    return { date: addDays(today, wd <= 4 ? 4 - wd : 11 - wd) }; // Friday
  }
  if ((m = new RegExp(`^in (${NUM}) (day|week|month|year)s?$`).exec(s))) {
    const n = toNumber(m[1]!);
    const unit = m[2]!;
    if (unit === 'day') return { date: addDays(today, n) };
    if (unit === 'week') return { date: addDays(today, n * 7) };
    if (unit === 'month') return { date: addMonths(today, n) };
    return { date: addYears(today, n) };
  }
  if ((m = new RegExp(`^(\\d{1,2})${ORD_SUFFIX}(?: of)? (${MONTH})(?:,? (\\d{4}))?$`).exec(s))) {
    return monthDay(Number(m[1]), monthIndex(m[2]!), m[3] ? Number(m[3]) : null, today);
  }
  if ((m = new RegExp(`^(${MONTH}) (\\d{1,2})${ORD_SUFFIX}(?:,? (\\d{4}))?$`).exec(s))) {
    return monthDay(Number(m[2]), monthIndex(m[1]!), m[3] ? Number(m[3]) : null, today);
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidYMD(y, mo, d) ? { date: makeDate(y, mo, d) } : null;
  }
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/.exec(s))) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (prefs.dateOrder === 'mdy') [a, b] = [b, a];
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    return monthDay(a, b, y, today);
  }
  if ((m = /^the (\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) return null;
    let y = Number(today.slice(0, 4));
    let mo = Number(today.slice(5, 7));
    for (let i = 0; i < 13; i++) {
      if (isValidYMD(y, mo, d) && makeDate(y, mo, d) >= today) return { date: makeDate(y, mo, d) };
      mo++;
      if (mo > 12) { mo = 1; y++; }
    }
    return null;
  }
  if ((m = new RegExp(`^(?:(next|this|coming) )?(${WD_ANY})$`).exec(s))) {
    const target = weekdayFromWord(m[2]!);
    const wd = weekdayIndex(today);
    const coming = addDays(today, (target - wd + 7) % 7 || (m[1] === 'coming' ? 7 : 0));
    if (m[1] === 'next') {
      // "next Friday" is genuinely ambiguous in UK English: offer both readings.
      const nextWeek = addDays(startOfWeek(today, 1), 7 + target);
      const strictlyComing = addDays(today, (target - wd + 7) % 7 || 7);
      if (nextWeek !== strictlyComing) {
        return {
          date: nextWeek,
          ambiguity: {
            message: `"${raw.trim()}" could mean next week or this coming ${WEEKDAY_NAMES[target]}`,
            options: [
              { label: `${WEEKDAY_NAMES[target]} next week (${formatRelativeDate(nextWeek, today, prefs)})`, date: nextWeek },
              { label: `This coming ${WEEKDAY_NAMES[target]} (${formatRelativeDate(strictlyComing, today, prefs)})`, date: strictlyComing },
            ],
          },
        };
      }
      return { date: nextWeek };
    }
    return { date: coming };
  }
  return null;
}

function monthDay(d: number, mo: number, y: number | null, today: ISODate): DateResolution | null {
  if (y !== null) return isValidYMD(y, mo, d) ? { date: makeDate(y, mo, d) } : null;
  const ty = Number(today.slice(0, 4));
  if (isValidYMD(ty, mo, d) && makeDate(ty, mo, d) >= today) return { date: makeDate(ty, mo, d) };
  return isValidYMD(ty + 1, mo, d) ? { date: makeDate(ty + 1, mo, d) } : null;
}

// ---------------------------------------------------------------------------
// Time & duration
// ---------------------------------------------------------------------------

function resolveTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^(at|@)\s*/, '');
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  let m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m[3]!.startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return `${pad(h)}:${pad(min)}`;
  }
  m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  return null;
}

function unitMinutes(unit: string): number {
  return unit.toLowerCase().startsWith('h') ? 60 : 1;
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

interface RecurrenceMatch {
  rule: RecurrenceRule;
  alternatives?: { label: string; rule: RecurrenceRule }[];
}

const base = (p: Partial<RecurrenceRule>): RecurrenceRule => ({ v: 1, freq: 'daily', interval: 1, basis: 'scheduled', ...p });

function parseWeekdayList(s: string): number[] {
  return [...new Set(s.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean).map(weekdayFromWord))].sort((a, b) => a - b);
}

const WD_LIST = `(?:${WD_ANY})(?:\\s*(?:,|and|&)\\s*(?:${WD_ANY}))*`;
const UNIT = '(day|week|month|year|fortnight)s?';
const UNIT_NC = '(?:day|week|month|year|fortnight)s?';

/** Resolve the body of a recurrence phrase (text after "every", or a standalone adverb). */
function resolveRecurrence(raw: string, today: ISODate, prefs: DatePrefs): RecurrenceMatch | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  let m: RegExpExecArray | null;
  if (/^(every ?day|daily)$/.test(s)) return { rule: base({}) };
  if (/^(every weekday|weekdays|every working day)$/.test(s)) return { rule: base({ weekdays: [0, 1, 2, 3, 4] }) };
  if (/^(every weekend|weekends)$/.test(s)) return { rule: base({ weekdays: [5, 6] }) };
  if (/^(every week|weekly)$/.test(s)) return { rule: base({ freq: 'weekly' }) };
  if (/^(every fortnight|fortnightly)$/.test(s)) return { rule: base({ freq: 'weekly', interval: 2 }) };
  if (/^(every month|monthly)$/.test(s)) return { rule: base({ freq: 'monthly' }) };
  if (/^(every year|yearly|annually)$/.test(s)) return { rule: base({ freq: 'yearly' }) };

  if ((m = new RegExp(`^every (?:(${NUM}|other) )?weeks? on (${WD_LIST})$`).exec(s))) {
    const n = !m[1] ? 1 : m[1] === 'other' ? 2 : toNumber(m[1]);
    if (n < 1) return null;
    return { rule: base({ freq: 'weekly', interval: n, weekdays: parseWeekdayList(m[2]!) }) };
  }
  if ((m = new RegExp(`^every (${NUM}|other) ${UNIT}$`).exec(s))) {
    const n = m[1] === 'other' ? 2 : toNumber(m[1]!);
    if (n < 1) return null;
    const unit = m[2]!;
    if (unit === 'fortnight') return { rule: base({ freq: 'weekly', interval: 2 * n }) };
    return { rule: base({ freq: `${unit === 'day' ? 'dai' : unit}ly` as RecurrenceRule['freq'], interval: n }) };
  }
  // "every (second|third) tuesday" / "every 2 tuesdays" — interval vs nth-of-month
  if ((m = new RegExp(`^every (${ORD}|\\d+) (${WD_ANY})s?(?: of (?:the|each|every) month)?$`).exec(s))) {
    const word = m[1]!;
    const wd = weekdayFromWord(m[2]!);
    const ofMonth = / of (the|each|every) month$/.test(s);
    const n = ORD_WORDS[word] ?? Number(word);
    const nth = base({ freq: 'monthly', nthWeekday: { n: Math.min(n, 5), weekday: wd } });
    const interval = base({ freq: 'weekly', interval: Math.max(1, n), weekdays: [wd] });
    if (ofMonth || word === 'first' || word === '1st' || word === 'last' || word === 'fourth' || word === '4th' || word === 'fifth' || word === '5th') {
      if (n < 1 && n !== -1) return null;
      return { rule: nth };
    }
    if (word === 'other' || /^\d+$/.test(word)) return { rule: interval };
    // second / third: ambiguous
    return {
      rule: interval,
      alternatives: [
        { label: describeRule(interval), rule: interval },
        { label: `The ${word} ${WEEKDAY_NAMES[wd]} of every month`, rule: nth },
      ],
    };
  }
  if ((m = new RegExp(`^every (${WD_LIST})$`).exec(s))) {
    return { rule: base({ freq: 'weekly', weekdays: parseWeekdayList(m[1]!) }) };
  }
  if ((m = new RegExp(`^(?:every )?(${ORD}) (${WD_ANY}) of (?:the|each|every) month$`).exec(s))) {
    const n = ORD_WORDS[m[1]!]!;
    return { rule: base({ freq: 'monthly', nthWeekday: { n: Math.min(n, 5), weekday: weekdayFromWord(m[2]!) } }) };
  }
  // "every 15th", "every month on the 15th", "monthly on the 1st and 15th", "every last day"
  if ((m = /^(?:every|every month on|monthly on|every month) (?:the )?((?:\d{1,2}(?:st|nd|rd|th)?|last day)(?:(?:,| and | & )(?:the )?(?:\d{1,2}(?:st|nd|rd|th)?|last day))*)(?: of (?:the|each|every) month)?$/.exec(s))) {
    const days = m[1]!
      .split(/,| and | & /)
      .map((x) => x.replace(/^the /, '').trim())
      .map((x) => (x === 'last day' ? -1 : parseInt(x, 10)));
    if (days.some((d) => d !== -1 && (d < 1 || d > 31))) return null;
    return { rule: base({ freq: 'monthly', monthDays: days }) };
  }
  // "every 20 nov", "every november 20th"
  if ((m = new RegExp(`^every (\\d{1,2})${ORD_SUFFIX}(?: of)? (${MONTH})$`).exec(s)) ||
      (m = new RegExp(`^every (${MONTH}) (\\d{1,2})${ORD_SUFFIX}$`).exec(s))) {
    const dayFirst = /^\d/.test(m[1]!);
    const d = Number(dayFirst ? m[1] : m[2]);
    const mo = monthIndex(dayFirst ? m[2]! : m[1]!);
    if (!isValidYMD(2028, mo, d)) return null;
    return { rule: base({ freq: 'yearly', month: mo, monthDays: [d] }) };
  }
  void today;
  void prefs;
  return null;
}

const RECURRENCE_SRC = [
  `every\\s+(?:(?:${NUM}|other)\\s+)?weeks?\\s+on\\s+${WD_LIST}`,
  `every\\s+(?:${NUM}|other)\\s+${UNIT_NC}`,
  `every\\s+(?:${ORD}|\\d+)\\s+(?:${WD_ANY})s?(?:\\s+of\\s+(?:the|each|every)\\s+month)?`,
  `(?:every\\s+)?(?:${ORD})\\s+(?:${WD_ANY})\\s+of\\s+(?:the|each|every)\\s+month`,
  `every\\s+(?:month\\s+on\\s+)?(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)|last\\s+day)(?:\\s*(?:,|and|&)\\s*(?:the\\s+)?(?:\\d{1,2}(?:st|nd|rd|th)?|last\\s+day))*(?:\\s+of\\s+(?:the|each|every)\\s+month)?`,
  `monthly\\s+on\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:,|and|&)\\s*(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?)*`,
  `every\\s+\\d{1,2}${ORD_SUFFIX}(?:\\s+of)?\\s+(?:${MONTH})`,
  `every\\s+(?:${MONTH})\\s+\\d{1,2}${ORD_SUFFIX}`,
  `every\\s+${WD_LIST}`,
  'every\\s+(?:working\\s+day|weekday|weekend|week|fortnight|month|year|day)|everyday|daily|weekly|fortnightly|monthly|yearly|annually|weekdays',
].map((s) => `(?:${s})`).join('|');

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

interface Matcher {
  kind: TokenKind;
  regex: RegExp;
  /** Return false to reject the match (it stays in the title). */
  apply: (m: RegExpExecArray, key: string) => boolean;
  /** Only accept the first match of this kind. */
  once?: boolean;
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[_-]+/g, ' ').trim();
}

export function parseQuickAdd(input: string, ctx: ParseContext = {}): ParseResult {
  const now = ctx.now ?? new Date();
  const prefs = ctx.prefs ?? UK_PREFS;
  const today = todayISO(now);
  const disabled = ctx.disabled ?? new Set<string>();
  const choices = ctx.choices ?? {};

  const result: ParseResult = {
    title: '',
    scheduledDate: null,
    scheduledTime: null,
    deadline: null,
    startDate: null,
    durationMinutes: null,
    priority: null,
    project: null,
    labels: [],
    recurrence: null,
    recurrenceText: null,
    tokens: [],
    ambiguities: [],
  };

  let work = input;
  const mask = (start: number, end: number) => {
    work = work.slice(0, start) + ' '.repeat(end - start) + work.slice(end);
  };

  const ambiguity = (key: string, message: string, options: string[]): number => {
    const sel = Math.min(Math.max(choices[key] ?? 0, 0), options.length - 1);
    result.ambiguities.push({ key, message, options, selected: sel });
    return sel;
  };

  const pickDate = (raw: string, key: string): ISODate | null => {
    const r = resolveDate(raw, today, prefs);
    if (!r) return null;
    if (r.ambiguity) {
      const sel = ambiguity(key, r.ambiguity.message, r.ambiguity.options.map((o) => o.label));
      return r.ambiguity.options[sel]!.date;
    }
    return r.date;
  };

  const projects = (ctx.projects ?? []).map((p) => ({ ...p, norm: normaliseName(p.name) }));
  const labels = (ctx.labels ?? []).map((l) => ({ ...l, norm: normaliseName(l.name) }));

  const matchers: Matcher[] = [
    {
      kind: 'recurrence',
      once: true,
      regex: new RegExp(
        `${B}(${RECURRENCE_SRC})(?:\\s+(?:after|from)\\s+(?:completion|completed|done))?(?:\\s+until\\s+(${DATE_LOOSE}))?${E}`,
        'giu',
      ),
      apply: (m, key) => {
        const body = m[1]!;
        const r = resolveRecurrence(body, today, prefs);
        if (!r) return false;
        let rule = r.rule;
        if (r.alternatives) {
          const sel = ambiguity(key, `"${body.trim()}" can be read two ways`, r.alternatives.map((a) => a.label));
          rule = r.alternatives[sel]!.rule;
        }
        if (/\s(after|from)\s+(completion|completed|done)/i.test(m[0])) rule = { ...rule, basis: 'completion' };
        if (m[2]) {
          const until = resolveDate(m[2], today, prefs)?.date;
          if (until) rule = { ...rule, until };
        }
        result.recurrence = rule;
        return true;
      },
    },
    {
      kind: 'deadline',
      once: true,
      regex: new RegExp(`${B}(?:by|before|deadline|due(?:\\s+(?:by|on))?)\\s+(${DATE_LOOSE})${E}`, 'giu'),
      apply: (m, key) => {
        const d = pickDate(m[1]!, key);
        if (!d) return false;
        result.deadline = d;
        return true;
      },
    },
    {
      kind: 'start',
      once: true,
      regex: new RegExp(`${B}(?:starting(?:\\s+on|\\s+from)?|starts(?:\\s+on)?|start\\s+on)\\s+(${DATE_LOOSE})${E}`, 'giu'),
      apply: (m, key) => {
        const d = pickDate(m[1]!, key);
        if (!d) return false;
        result.startDate = d;
        return true;
      },
    },
    {
      kind: 'duration',
      once: true,
      regex: new RegExp(
        `${B}(?:for\\s+(?:(an?|half\\s+an?)\\s+hour|(\\d+(?:\\.\\d+)?)\\s*(minutes?|mins?|m|hours?|hrs?|h)(?:\\s+(?:and\\s+)?(\\d+)\\s*(minutes?|mins?|m))?)|(\\d+)h(?:\\s*(\\d+)\\s*m(?:ins?)?)?|(\\d+(?:\\.\\d+)?)\\s*(?:hrs?|hours?)|(\\d+)\\s*(?:mins?|minutes))${E}`,
        'giu',
      ),
      apply: (m) => {
        let minutes: number;
        if (m[1]) minutes = /half/i.test(m[1]) ? 30 : 60;
        else if (m[2]) minutes = Number(m[2]) * unitMinutes(m[3]!) + (m[4] ? Number(m[4]) : 0);
        else if (m[6]) minutes = Number(m[6]) * 60 + (m[7] ? Number(m[7]) : 0);
        else if (m[8]) minutes = Number(m[8]) * 60;
        else minutes = Number(m[9]);
        minutes = Math.round(minutes);
        if (!(minutes > 0) || minutes > 60 * 24 * 30) return false;
        result.durationMinutes = minutes;
        return true;
      },
    },
    {
      kind: 'time',
      once: true,
      regex: new RegExp(
        `${B}(?:(?:at\\s+|@\\s*)?\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)|(?:at\\s+)?(?:[01]?\\d|2[0-3]):[0-5]\\d|at\\s+\\d{1,2}(?:\\.\\d{2})?(?!\\s*(?:st|nd|rd|th|/|${MONTH}))|(?:at\\s+)?(?:noon|midday|midnight))(?![\\p{L}\\p{N}_])`,
        'giu',
      ),
      apply: (m) => {
        const t = resolveTime(m[0]);
        if (!t) return false;
        result.scheduledTime = t;
        return true;
      },
    },
    {
      kind: 'date',
      once: true,
      regex: new RegExp(`${B}(?:on\\s+)?(${DATE_STRICT})${E}`, 'giu'),
      apply: (m, key) => {
        const d = pickDate(m[1]!, key);
        if (!d) return false;
        result.scheduledDate = d;
        return true;
      },
    },
    {
      kind: 'priority',
      once: true,
      regex: new RegExp(`${B}p([1-4])${E}`, 'giu'),
      apply: (m) => {
        result.priority = Number(m[1]) as Priority;
        return true;
      },
    },
    {
      kind: 'project',
      once: true,
      regex: /(?<=^|\s)#([^\s#@]+(?:\s+[^\s#@]+)*)/gu,
      apply: (m) => {
        // Longest known project name that prefixes the text after '#'. Shrink the match to it.
        const after = m[1]!;
        const words = after.split(/\s+/);
        for (let n = words.length; n >= 1; n--) {
          const candidate = normaliseName(words.slice(0, n).join(' '));
          const p = projects.find((x) => x.norm === candidate);
          if (p) {
            result.project = { id: p.id, name: p.name, isNew: false };
            return shrink(m, 1 + words.slice(0, n).join(' ').length);
          }
        }
        const first = words[0]!;
        const lbl = labels.find((x) => x.norm === normaliseName(first));
        if (lbl) {
          // "#home" where only a label "home" exists → treat as that label.
          if (!result.labels.some((l) => l.id === lbl.id)) result.labels.push({ id: lbl.id, name: lbl.name, isNew: false });
          return shrink(m, 1 + first.length);
        }
        result.project = { id: null, name: first.replace(/[_-]+/g, ' '), isNew: true };
        return shrink(m, 1 + first.length);
      },
    },
    {
      kind: 'label',
      regex: /(?<=^|\s)@([^\s#@]+)/gu,
      apply: (m) => {
        const name = m[1]!;
        const lbl = labels.find((x) => x.norm === normaliseName(name));
        const ref = lbl ? { id: lbl.id, name: lbl.name, isNew: false } : { id: null, name, isNew: true };
        if (!result.labels.some((l) => normaliseName(l.name) === normaliseName(ref.name))) result.labels.push(ref);
        return true;
      },
    },
  ];

  // Lets a matcher accept only a prefix of its regex match.
  const accepted = { length: null as number | null };
  function shrink(_m: RegExpExecArray, len: number): boolean {
    accepted.length = len;
    return true;
  }

  for (const matcher of matchers) {
    matcher.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.regex.exec(work)) !== null) {
      if (m[0].trim() === '') {
        matcher.regex.lastIndex = m.index + 1;
        continue;
      }
      const start = m.index;
      const key = `${matcher.kind}@${start}`;
      if (disabled.has(key)) {
        // Still record the token so the UI can show it as switched off and let the user turn it back on.
        continue;
      }
      accepted.length = null;
      const ambiguityCount = result.ambiguities.length;
      if (matcher.apply(m, key)) {
        const end = start + (accepted.length ?? m[0].length);
        result.tokens.push({ key, kind: matcher.kind, start, end, text: input.slice(start, end) });
        mask(start, end);
        matcher.regex.lastIndex = end;
        if (matcher.once) break;
      } else {
        result.ambiguities.length = ambiguityCount;
      }
    }
  }

  // Title = remaining text with dangling connector words tidied.
  result.title = work
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(on|at|by|for|from|every|and)$/i, '')
    .trim();

  // Resolve dates that depend on other fields.
  if (result.recurrence) {
    const from = result.scheduledDate ?? result.startDate ?? today;
    const first = firstOccurrenceOnOrAfter(result.recurrence, from) ?? from;
    result.scheduledDate = first;
    result.recurrence = { ...result.recurrence, anchor: first };
    result.recurrenceText = describeRule(result.recurrence);
  }
  if (result.scheduledTime && !result.scheduledDate) {
    const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    result.scheduledDate = result.scheduledTime > nowHM ? today : addDays(today, 1);
  }
  if (result.startDate && result.scheduledDate && result.scheduledDate < result.startDate) {
    result.ambiguities.push({
      key: 'start-after-scheduled',
      message: 'The start date is after the scheduled date — check the dates before saving.',
      options: [],
      selected: 0,
    });
  }
  if (result.deadline && result.scheduledDate && result.scheduledDate > result.deadline) {
    result.ambiguities.push({
      key: 'scheduled-after-deadline',
      message: 'This is scheduled after its deadline.',
      options: [],
      selected: 0,
    });
  }
  result.tokens.sort((a, b) => a.start - b.start);
  return result;
}

/**
 * Imported tasks (Claude links, shares, Capture) go to the Inbox for the user to file, so a
 * "#Project" in the text must not choose or create a project. Removes project tags and returns
 * the names they asked for (shown to the user as a suggestion). "#name" that means a label stays.
 */
export function stripProjectTags(text: string, ctx: ParseContext = {}): { text: string; suggested: string[] } {
  const suggested: string[] = [];
  let out = text;
  for (let i = 0; i < 10; i++) {
    const parsed = parseQuickAdd(out, ctx);
    const tok = parsed.project && parsed.tokens.find((t) => t.kind === 'project');
    if (!parsed.project || !tok) break;
    suggested.push(parsed.project.name);
    out = (out.slice(0, tok.start) + out.slice(tok.end)).replace(/[ \t]{2,}/g, ' ').trim();
  }
  return { text: out, suggested };
}
