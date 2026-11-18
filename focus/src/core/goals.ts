/**
 * Goals and streaks (spec 6.3). Informative rather than gamified: no points or badges,
 * targets are optional, and days you don't work (per Settings → working days, if chosen)
 * never break a streak.
 */
import { addDays, startOfWeek, type ISODate } from './dates';

export interface Goals {
  /** Tasks to complete per day / week; null = no target. */
  dailyTasks: number | null;
  weeklyTasks: number | null;
  /** Tracked minutes per day / week; null = no target. */
  dailyMinutes: number | null;
  weeklyMinutes: number | null;
  /** Skip non-working days when counting daily streaks. */
  skipNonWorkingDays: boolean;
}

export const NO_GOALS: Goals = { dailyTasks: null, weeklyTasks: null, dailyMinutes: null, weeklyMinutes: null, skipNonWorkingDays: true };

export interface DayActivity {
  completed: number;
  minutes: number;
}

/** True if the day meets every daily target that is set. */
export function dayMeets(a: DayActivity | undefined, g: Goals): boolean {
  const x = a ?? { completed: 0, minutes: 0 };
  if (g.dailyTasks === null && g.dailyMinutes === null) return false;
  return (g.dailyTasks === null || x.completed >= g.dailyTasks) && (g.dailyMinutes === null || x.minutes >= g.dailyMinutes);
}

export function weekMeets(total: DayActivity, g: Goals): boolean {
  if (g.weeklyTasks === null && g.weeklyMinutes === null) return false;
  return (g.weeklyTasks === null || total.completed >= g.weeklyTasks) && (g.weeklyMinutes === null || total.minutes >= g.weeklyMinutes);
}

export interface Streak {
  current: number;
  best: number;
}

/**
 * Daily streak over the activity history. Today counts if already met, but an unmet
 * today does not break the streak (the day isn't over).
 *
 * @param isWorkingDay days for which `false` are skipped when skipNonWorkingDays is on
 * @param since earliest day to consider (e.g. first activity)
 */
export function dailyStreak(
  activity: ReadonlyMap<ISODate, DayActivity>,
  g: Goals,
  today: ISODate,
  since: ISODate,
  isWorkingDay: (d: ISODate) => boolean,
): Streak {
  if (g.dailyTasks === null && g.dailyMinutes === null) return { current: 0, best: 0 };
  const skip = (d: ISODate) => g.skipNonWorkingDays && !isWorkingDay(d) && !dayMeets(activity.get(d), g);
  let best = 0;
  let run = 0;
  for (let d = since; d <= today; d = addDays(d, 1)) {
    if (skip(d)) continue;
    if (dayMeets(activity.get(d), g)) run++;
    else if (d !== today) run = 0;
    best = Math.max(best, run);
  }
  return { current: run, best };
}

/** Weekly streak: consecutive weeks meeting the weekly target; the current week counts once met. */
export function weeklyStreak(activity: ReadonlyMap<ISODate, DayActivity>, g: Goals, today: ISODate, since: ISODate, weekStartsOn: 0 | 1): Streak {
  if (g.weeklyTasks === null && g.weeklyMinutes === null) return { current: 0, best: 0 };
  const thisWeek = startOfWeek(today, weekStartsOn);
  let best = 0;
  let run = 0;
  for (let w = startOfWeek(since, weekStartsOn); w <= thisWeek; w = addDays(w, 7)) {
    if (weekMeets(weekTotal(activity, w), g)) run++;
    else if (w !== thisWeek) run = 0;
    best = Math.max(best, run);
  }
  return { current: run, best };
}

export function weekTotal(activity: ReadonlyMap<ISODate, DayActivity>, weekStart: ISODate): DayActivity {
  const total = { completed: 0, minutes: 0 };
  for (let i = 0; i < 7; i++) {
    const a = activity.get(addDays(weekStart, i));
    if (a) {
      total.completed += a.completed;
      total.minutes += a.minutes;
    }
  }
  return total;
}
