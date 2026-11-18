import { describe, expect, it } from 'vitest';
import { parseQuickAdd, resolveDate } from './parser';

// Saturday 14 November 2026, 10:00 local
const now = new Date(2026, 10, 14, 10, 0);
const projects = [
  { id: 'p-home', name: 'Home' },
  { id: 'p-work', name: 'Work' },
  { id: 'p-hi', name: 'Home Improvements' },
];
const labels = [
  { id: 'l-calls', name: 'calls' },
  { id: 'l-errands', name: 'errands' },
];
const parse = (s: string, extra: Partial<Parameters<typeof parseQuickAdd>[1]> = {}) =>
  parseQuickAdd(s, { now, projects, labels, ...extra });

describe('spec examples', () => {
  it('Buy batteries tomorrow', () => {
    const r = parse('Buy batteries tomorrow');
    expect(r.title).toBe('Buy batteries');
    expect(r.scheduledDate).toBe('2026-11-15');
  });
  it('Phone dentist Friday 10am', () => {
    const r = parse('Phone dentist Friday 10am');
    expect(r.title).toBe('Phone dentist');
    expect(r.scheduledDate).toBe('2026-11-20');
    expect(r.scheduledTime).toBe('10:00');
  });
  it('Check meter every second Tuesday (ambiguous)', () => {
    const r = parse('Check meter every second Tuesday');
    expect(r.title).toBe('Check meter');
    expect(r.recurrence).toMatchObject({ freq: 'weekly', interval: 2, weekdays: [1] });
    expect(r.scheduledDate).toBe('2026-11-17');
    expect(r.ambiguities).toHaveLength(1);
    expect(r.ambiguities[0]!.options[1]).toMatch(/second Tuesday of every month/);
    const key = r.ambiguities[0]!.key;
    const alt = parse('Check meter every second Tuesday', { choices: { [key]: 1 } });
    expect(alt.recurrence).toMatchObject({ freq: 'monthly', nthWeekday: { n: 2, weekday: 1 } });
    expect(alt.scheduledDate).toBe('2026-12-08');
  });
  it('Finish report by 20 November', () => {
    const r = parse('Finish report by 20 November');
    expect(r.title).toBe('Finish report');
    expect(r.deadline).toBe('2026-11-20');
    expect(r.scheduledDate).toBeNull();
  });
  it('Replace kitchen tap #home p2', () => {
    const r = parse('Replace kitchen tap #home p2');
    expect(r.title).toBe('Replace kitchen tap');
    expect(r.project).toEqual({ id: 'p-home', name: 'Home', isNew: false });
    expect(r.priority).toBe(2);
  });
});

describe('dates', () => {
  it.each([
    ['today', '2026-11-14'],
    ['tomorrow', '2026-11-15'],
    ['monday', '2026-11-16'],
    ['this saturday', '2026-11-14'],
    ['in 3 days', '2026-11-17'],
    ['in two weeks', '2026-11-28'],
    ['in a month', '2026-12-14'],
    ['next week', '2026-11-16'],
    ['next month', '2026-12-01'],
    ['weekend', '2026-11-14'],
    ['end of month', '2026-11-30'],
    ['3 March', '2027-03-03'],
    ['1st of March 2028', '2028-03-01'],
    ['December 25th', '2026-12-25'],
    ['25/12', '2026-12-25'],
    ['03/04/2027', '2027-04-03'],
    ['2027-01-05', '2027-01-05'],
    ['on the 20th', '2026-11-20'],
    ['on the 3rd', '2026-12-03'],
  ])('%s → %s', (phrase, expected) => {
    expect(resolveDate(phrase, '2026-11-14')?.date).toBe(expected);
  });

  it('rejects impossible dates', () => {
    expect(resolveDate('31/02', '2026-11-14')).toBeNull();
    expect(resolveDate('2027-13-01', '2026-11-14')).toBeNull();
  });

  it('US order when configured', () => {
    expect(resolveDate('03/04/2027', '2026-11-14', { dateOrder: 'mdy', hour12: true, weekStartsOn: 0 })?.date).toBe('2027-03-04');
  });

  it('"next friday" offers both readings when they differ', () => {
    // Wednesday 11 Nov 2026: coming Friday is 13th, Friday next week is 20th
    const r = parseQuickAdd('Ring Sam next friday', { now: new Date(2026, 10, 11, 9) });
    expect(r.scheduledDate).toBe('2026-11-20');
    expect(r.ambiguities[0]!.options).toHaveLength(2);
    const alt = parseQuickAdd('Ring Sam next friday', { now: new Date(2026, 10, 11, 9), choices: { [r.ambiguities[0]!.key]: 1 } });
    expect(alt.scheduledDate).toBe('2026-11-13');
  });

  it('abbreviated weekday words are not mistaken for dates in titles', () => {
    expect(parse('Buy sun cream').scheduledDate).toBeNull();
    expect(parse('Buy sun cream').title).toBe('Buy sun cream');
    expect(parse('Gym on sat').scheduledDate).toBe('2026-11-14');
  });

  it('bare ordinals stay in the title', () => {
    expect(parse('Plan the 20th anniversary').title).toBe('Plan the 20th anniversary');
  });
});

describe('times', () => {
  it.each([
    ['Call at 3pm', '15:00'],
    ['Call 9:30am', '09:30'],
    ['Call at 14:00', '14:00'],
    ['Call at 7', '07:00'],
    ['Lunch at noon', '12:00'],
    ['Call 12am', '00:00'],
    ['Call 12.15pm', '12:15'],
  ])('%s → %s', (s, t) => {
    expect(parse(s).scheduledTime).toBe(t);
  });
  it('time without a date: today if still ahead, otherwise tomorrow', () => {
    expect(parse('Call at 3pm').scheduledDate).toBe('2026-11-14');
    expect(parse('Call at 8am').scheduledDate).toBe('2026-11-15');
  });
  it('rejects invalid times', () => {
    expect(parse('Call at 13pm').scheduledTime).toBeNull();
  });
});

describe('durations', () => {
  it.each([
    ['Write for 30m', 30],
    ['Write for 1h', 60],
    ['Write for 1.5 hours', 90],
    ['Write for 1 hour 30 minutes', 90],
    ['Write for an hour', 60],
    ['Write for half an hour', 30],
    ['Write 2h', 120],
    ['Write 1h30m', 90],
    ['Write 45 mins', 45],
  ])('%s → %i', (s, n) => {
    const r = parse(s);
    expect(r.durationMinutes).toBe(n);
    expect(r.title).toBe('Write');
  });
});

describe('recurrence', () => {
  it.each([
    ['Stand-up every weekday', { freq: 'daily', weekdays: [0, 1, 2, 3, 4] }, '2026-11-16'],
    ['Water plants every 3 days', { freq: 'daily', interval: 3 }, '2026-11-14'],
    ['Bins every monday', { freq: 'weekly', weekdays: [0] }, '2026-11-16'],
    ['Gym every mon, wed and fri', { freq: 'weekly', weekdays: [0, 2, 4] }, '2026-11-16'],
    ['Payroll every month on the 15th', { freq: 'monthly', monthDays: [15] }, '2026-11-15'],
    ['Rent every 1st', { freq: 'monthly', monthDays: [1] }, '2026-12-01'],
    ['Review first monday of each month', { freq: 'monthly', nthWeekday: { n: 1, weekday: 0 } }, '2026-12-07'],
    ['Report every last friday of the month', { freq: 'monthly', nthWeekday: { n: -1, weekday: 4 } }, '2026-11-27'],
    ['Birthday every 20 nov', { freq: 'yearly', month: 11, monthDays: [20] }, '2026-11-20'],
    ['Clean fortnightly', { freq: 'weekly', interval: 2 }, '2026-11-14'],
    ['Check every other week', { freq: 'weekly', interval: 2 }, '2026-11-14'],
    ['Backups daily', { freq: 'daily' }, '2026-11-14'],
    ['Swim every 2 weeks on tue and thu', { freq: 'weekly', interval: 2, weekdays: [1, 3] }, '2026-11-17'],
    ['Team call every week on monday', { freq: 'weekly', interval: 1, weekdays: [0] }, '2026-11-16'],
  ])('%s', (s, rule, firstDate) => {
    const r = parse(s);
    expect(r.recurrence).toMatchObject(rule);
    expect(r.scheduledDate).toBe(firstDate);
    expect(r.recurrence!.anchor).toBe(firstDate);
    expect(r.recurrenceText).toBeTruthy();
  });
  it('completion basis', () => {
    const r = parse('Descale kettle every 4 weeks after completion');
    expect(r.recurrence).toMatchObject({ freq: 'weekly', interval: 4, basis: 'completion' });
    expect(r.title).toBe('Descale kettle');
  });
  it('recurrence with time and explicit start', () => {
    const r = parse('Meds every day at 8am starting 1 December');
    expect(r.recurrence).toMatchObject({ freq: 'daily' });
    expect(r.scheduledTime).toBe('08:00');
    expect(r.startDate).toBe('2026-12-01');
    expect(r.scheduledDate).toBe('2026-12-01');
  });
  it('until', () => {
    expect(parse('Physio every monday until 31/12').recurrence?.until).toBe('2026-12-31');
  });
});

describe('projects, labels, priority', () => {
  it('multi-word project names match the longest known project', () => {
    const r = parse('Paint fence #Home Improvements p1');
    expect(r.project?.id).toBe('p-hi');
    expect(r.title).toBe('Paint fence');
  });
  it('unknown project is flagged as new', () => {
    const r = parse('Book hotel #holiday');
    expect(r.project).toEqual({ id: null, name: 'holiday', isNew: true });
  });
  it('# falls back to an existing label', () => {
    const r = parse('Pick up parcel #errands');
    expect(r.project).toBeNull();
    expect(r.labels).toEqual([{ id: 'l-errands', name: 'errands', isNew: false }]);
  });
  it('multiple labels, new and existing', () => {
    const r = parse('Ring plumber @calls @urgent');
    expect(r.labels).toEqual([
      { id: 'l-calls', name: 'calls', isNew: false },
      { id: null, name: 'urgent', isNew: true },
    ]);
    expect(r.title).toBe('Ring plumber');
  });
  it('ignores # and @ inside words (emails, URLs)', () => {
    const r = parse('Email bob@example.com about page#2');
    expect(r.labels).toEqual([]);
    expect(r.project).toBeNull();
    expect(r.title).toBe('Email bob@example.com about page#2');
  });
});

describe('manual correction and tokens', () => {
  it('returns token spans in input order', () => {
    const r = parse('Call mum tomorrow at 6pm p1 @calls');
    expect(r.tokens.map((t) => t.kind)).toEqual(['date', 'time', 'priority', 'label']);
    expect(r.tokens[0]!.text).toBe('tomorrow');
  });
  it('disabling a token puts the text back in the title', () => {
    const first = parse('Read Tomorrow and Tomorrow');
    const key = first.tokens.find((t) => t.kind === 'date')!.key;
    const r = parse('Read Tomorrow and Tomorrow', { disabled: new Set([key]) });
    // the first occurrence is disabled; the parser does not jump to the second one silently
    expect(r.title).toContain('Read Tomorrow');
  });
  it('warns when scheduled after deadline', () => {
    const r = parse('Submit form friday by thursday');
    expect(r.ambiguities.some((a) => a.key === 'scheduled-after-deadline')).toBe(true);
  });
  it('plain text passes through untouched', () => {
    const r = parse('Think about life');
    expect(r).toMatchObject({ title: 'Think about life', scheduledDate: null, priority: null, tokens: [] });
  });
});
