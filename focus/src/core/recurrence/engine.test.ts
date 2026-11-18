import { describe, expect, it } from 'vitest';
import { describeRule, firstOccurrenceOnOrAfter, nextOccurrence, nthWeekdayOfMonth, occurrenceAfter, previewOccurrences } from './engine';
import type { RecurrenceRule } from './types';

const r = (p: Partial<RecurrenceRule>): RecurrenceRule => ({ v: 1, freq: 'daily', interval: 1, basis: 'scheduled', ...p });

describe('occurrenceAfter', () => {
  it('daily', () => {
    expect(occurrenceAfter(r({}), '2026-11-01', '2026-11-14')).toBe('2026-11-15');
  });
  it('every 3 days stays aligned to the anchor', () => {
    expect(occurrenceAfter(r({ interval: 3 }), '2026-11-01', '2026-11-14')).toBe('2026-11-16');
  });
  it('every weekday skips the weekend', () => {
    // 2026-11-13 is a Friday
    expect(occurrenceAfter(r({ weekdays: [0, 1, 2, 3, 4] }), '2026-11-01', '2026-11-13')).toBe('2026-11-16');
  });
  it('weekly on several weekdays', () => {
    const rule = r({ freq: 'weekly', weekdays: [0, 2] }); // Mon, Wed
    expect(occurrenceAfter(rule, '2026-11-02', '2026-11-16')).toBe('2026-11-18');
    expect(occurrenceAfter(rule, '2026-11-02', '2026-11-18')).toBe('2026-11-23');
  });
  it('fortnightly keeps the cycle', () => {
    const rule = r({ freq: 'weekly', interval: 2, weekdays: [1] }); // Tue
    // anchor Tue 3 Nov 2026 → 17 Nov, 1 Dec
    expect(occurrenceAfter(rule, '2026-11-03', '2026-11-03')).toBe('2026-11-17');
    expect(occurrenceAfter(rule, '2026-11-03', '2026-11-20')).toBe('2026-12-01');
  });
  it('monthly on the 31st clamps to month end', () => {
    const rule = r({ freq: 'monthly', monthDays: [31] });
    expect(occurrenceAfter(rule, '2027-01-31', '2027-01-31')).toBe('2027-02-28');
    expect(occurrenceAfter(rule, '2027-01-31', '2027-02-28')).toBe('2027-03-31');
  });
  it('monthly last day', () => {
    expect(occurrenceAfter(r({ freq: 'monthly', monthDays: [-1] }), '2028-01-01', '2028-01-31')).toBe('2028-02-29');
  });
  it('first Monday of each month', () => {
    const rule = r({ freq: 'monthly', nthWeekday: { n: 1, weekday: 0 } });
    expect(occurrenceAfter(rule, '2026-11-01', '2026-11-02')).toBe('2026-12-07');
  });
  it('last Friday of each month', () => {
    const rule = r({ freq: 'monthly', nthWeekday: { n: -1, weekday: 4 } });
    expect(occurrenceAfter(rule, '2026-11-01', '2026-11-01')).toBe('2026-11-27');
  });
  it('fifth weekday skips months without one', () => {
    const rule = r({ freq: 'monthly', nthWeekday: { n: 5, weekday: 0 } });
    // Nov 2026 has Mondays 2,9,16,23,30 → 30th; Dec has 7..28 (4 Mondays); next 5th Monday is Feb? Mar 2027 has 1,8,15,22,29
    expect(occurrenceAfter(rule, '2026-11-01', '2026-11-01')).toBe('2026-11-30');
    expect(occurrenceAfter(rule, '2026-11-01', '2026-11-30')).toBe('2027-03-29');
  });
  it('yearly on 29 Feb clamps in common years', () => {
    expect(occurrenceAfter(r({ freq: 'yearly' }), '2028-02-29', '2028-02-29')).toBe('2029-02-28');
  });
  it('respects until', () => {
    expect(occurrenceAfter(r({ until: '2026-11-15' }), '2026-11-01', '2026-11-15')).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('scheduled basis, completed on the day → next day', () => {
    expect(nextOccurrence({ rule: r({}), scheduledDate: '2026-11-14', completedOn: '2026-11-14', today: '2026-11-14' })).toBe('2026-11-15');
  });
  it('scheduled basis, overdue jumps to the future rather than more overdue copies', () => {
    expect(nextOccurrence({ rule: r({}), scheduledDate: '2026-11-09', completedOn: '2026-11-14', today: '2026-11-14' })).toBe('2026-11-15');
  });
  it('scheduled basis, completed early keeps the pattern', () => {
    const rule = r({ freq: 'weekly', weekdays: [4], anchor: '2026-11-06' }); // Fridays
    expect(nextOccurrence({ rule, scheduledDate: '2026-11-20', completedOn: '2026-11-14', today: '2026-11-14' })).toBe('2026-11-27');
  });
  it('completion basis counts from completion day', () => {
    const rule = r({ interval: 10, basis: 'completion' });
    expect(nextOccurrence({ rule, scheduledDate: '2026-11-01', completedOn: '2026-11-14', today: '2026-11-14' })).toBe('2026-11-24');
  });
  it('completion basis monthly', () => {
    const rule = r({ freq: 'monthly', basis: 'completion' });
    expect(nextOccurrence({ rule, scheduledDate: null, completedOn: '2026-11-14', today: '2026-11-14' })).toBe('2026-12-14');
  });
});

describe('helpers', () => {
  it('nthWeekdayOfMonth', () => {
    expect(nthWeekdayOfMonth(2026, 11, 1, 2)).toBe('2026-11-10'); // 2nd Tuesday
    expect(nthWeekdayOfMonth(2026, 2, 0, 5)).toBeNull();
  });
  it('firstOccurrenceOnOrAfter picks the nearest matching day', () => {
    // Saturday 14 Nov 2026 → next Tuesday 17 Nov, even for a fortnightly rule
    expect(firstOccurrenceOnOrAfter(r({ freq: 'weekly', interval: 2, weekdays: [1] }), '2026-11-14')).toBe('2026-11-17');
    expect(firstOccurrenceOnOrAfter(r({}), '2026-11-14')).toBe('2026-11-14');
  });
  it('previewOccurrences', () => {
    expect(previewOccurrences(r({ freq: 'weekly' }), '2026-11-14', 3)).toEqual(['2026-11-14', '2026-11-21', '2026-11-28']);
  });
  it('describeRule', () => {
    expect(describeRule(r({}))).toBe('Every day');
    expect(describeRule(r({ weekdays: [0, 1, 2, 3, 4] }))).toBe('Every weekday');
    expect(describeRule(r({ freq: 'weekly', interval: 2, weekdays: [1] }))).toBe('Every 2 weeks on Tuesday');
    expect(describeRule(r({ freq: 'monthly', nthWeekday: { n: 1, weekday: 0 } }))).toBe('Every month on the first Monday');
    expect(describeRule(r({ freq: 'monthly', monthDays: [15] }))).toBe('Every month on the 15th');
    expect(describeRule(r({ interval: 3, basis: 'completion' }))).toBe('Every 3 days after completion');
  });
});
