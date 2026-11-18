import { describe, expect, it } from 'vitest';
import { weekdayIndex } from './dates';
import { dailyStreak, dayMeets, NO_GOALS, weeklyStreak, weekTotal, type DayActivity } from './goals';

const act = (entries: Record<string, [number, number]>) => new Map<string, DayActivity>(Object.entries(entries).map(([d, [completed, minutes]]) => [d, { completed, minutes }]));
const weekdays = (d: string) => weekdayIndex(d) < 5;
const goals = { ...NO_GOALS, dailyTasks: 3 };

describe('goals', () => {
  it('meets a day only when every set target is reached', () => {
    expect(dayMeets({ completed: 3, minutes: 0 }, goals)).toBe(true);
    expect(dayMeets({ completed: 3, minutes: 10 }, { ...goals, dailyMinutes: 30 })).toBe(false);
    expect(dayMeets({ completed: 9, minutes: 99 }, NO_GOALS)).toBe(false);
  });

  it('counts a daily streak, skipping weekends and not breaking on an unfinished today', () => {
    // Thu 12 – Mon 16 Nov 2026 (16th is today, not yet met).
    const a = act({ '2026-11-11': [1, 0], '2026-11-12': [3, 0], '2026-11-13': [4, 0], '2026-11-16': [1, 0] });
    expect(dailyStreak(a, goals, '2026-11-16', '2026-11-09', weekdays)).toEqual({ current: 2, best: 2 });
    // Without skipping, the weekend breaks it.
    expect(dailyStreak(a, { ...goals, skipNonWorkingDays: false }, '2026-11-16', '2026-11-09', weekdays).current).toBe(0);
    // A weekend day where the goal was met still counts.
    const b = act({ '2026-11-13': [3, 0], '2026-11-14': [3, 0], '2026-11-16': [3, 0] });
    expect(dailyStreak(b, goals, '2026-11-16', '2026-11-13', weekdays).current).toBe(3);
  });

  it('counts weekly streaks and totals', () => {
    const a = act({ '2026-11-03': [5, 0], '2026-11-10': [2, 0], '2026-11-12': [4, 0], '2026-11-16': [1, 0] });
    expect(weekTotal(a, '2026-11-09')).toEqual({ completed: 6, minutes: 0 });
    const g = { ...NO_GOALS, weeklyTasks: 5 };
    expect(weeklyStreak(a, g, '2026-11-16', '2026-11-02', 1)).toEqual({ current: 2, best: 2 });
  });
});
