import { addDays, startOfWeek, todayISO, weekdayIndex, type ISODate } from '@/core/dates';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { dailyStreak, dayMeets, weeklyStreak, weekTotal, type DayActivity, type Goals, type Streak } from '@/core/goals';
import {
  autoGranularity,
  completedByLabel,
  completedByProject,
  createdVsCompleted,
  dueDateOf,
  dueDateTrend,
  localDay,
  LONG_TIMER_MINUTES,
  priorityDistribution,
  projectProgress,
  recurringCompletion,
  timeReport,
  totals,
  entryMinutes,
  type DateRange,
  type Granularity,
} from '@/core/insights';
import { workload } from '@/core/scheduling';
import type { Repositories } from '@/data';
import { goalsSchema } from '@/data/repositories/settings';

export interface GoalStatus {
  goals: Goals;
  today: DayActivity;
  week: DayActivity;
  todayMet: boolean;
  daily: Streak;
  weekly: Streak;
  /** Last 12 weeks, oldest first: totals and whether the weekly target was met. */
  history: { week: ISODate; completed: number; minutes: number; met: boolean | null }[];
}

/** Reports over stored data (spec 6.1–6.3). All numbers come from real timestamps. */
export class InsightsService {
  constructor(
    private r: Repositories,
    private now: () => Date = () => new Date(),
  ) {}

  today(): ISODate {
    return todayISO(this.now());
  }

  report(range: DateRange, granularity: Granularity = autoGranularity(range)) {
    const s = this.r.settings.getAll();
    const today = this.today();
    const tasks = this.r.tasks.listForReports();
    const wk = s.weekStartsOn;
    const entries = this.r.time.listAll();
    const open = tasks.filter((t) => isOpenStatus(t.status) && !t.deletedAt);
    return {
      range,
      granularity,
      totals: totals(tasks, range, today),
      createdVsCompleted: createdVsCompleted(tasks, range, granularity, wk),
      byProject: completedByProject(tasks, range),
      byLabel: completedByLabel(tasks, range),
      priority: priorityDistribution(tasks, range),
      dueTrend: dueDateTrend(tasks, range, granularity, today, wk),
      recurring: recurringCompletion(tasks, range, today),
      projects: projectProgress(tasks),
      time: timeReport(entries, tasks, range, this.now(), wk),
      workload: workload(open, today, addDays(today, 13), { hours: s.workingHours, defaultEstimate: s.defaultEstimate }),
      lists: this.lists(open, tasks, today),
      goals: this.goalStatus(tasks),
    };
  }

  private lists(open: Task[], all: Task[], today: ISODate) {
    const byDue = (a: Task, b: Task) => (dueDateOf(a) ?? '').localeCompare(dueDateOf(b) ?? '') || a.priority - b.priority;
    const top = (ts: Task[]) => ts.filter((t) => !t.parentId || dueDateOf(t)).sort(byDue).slice(0, 8);
    return {
      today: top(open.filter((t) => (dueDateOf(t) === today || t.scheduledDate === today || t.pinnedToday) && !(t.startDate && t.startDate > today))),
      overdue: top(open.filter((t) => (dueDateOf(t) ?? today) < today)),
      deadlines: top(open.filter((t) => t.deadline && t.deadline >= today && t.deadline <= addDays(today, 14))),
      waiting: top(open.filter((t) => t.status === 'waiting')),
      recent: all
        .filter((t) => t.status === 'completed' && t.completedAt && !t.deletedAt)
        .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
        .slice(0, 8),
    };
  }

  /** Completed tasks and tracked minutes per local day. */
  activity(tasks: readonly Task[] = this.r.tasks.listForReports()): Map<ISODate, DayActivity> {
    const m = new Map<ISODate, DayActivity>();
    const get = (d: ISODate) => m.get(d) ?? (m.set(d, { completed: 0, minutes: 0 }), m.get(d)!);
    for (const t of tasks) if (t.status === 'completed' && t.completedAt && !t.deletedAt) get(localDay(t.completedAt)).completed++;
    for (const e of this.r.time.listAll()) if (e.endedAt) get(localDay(e.startedAt)).minutes += e.minutes ?? 0;
    return m;
  }

  goalStatus(tasks: readonly Task[] = this.r.tasks.listForReports()): GoalStatus {
    const s = this.r.settings.getAll();
    const goals = s.goals;
    const today = this.today();
    const activity = this.activity(tasks);
    const days = [...activity.keys()].sort();
    const since = days[0] && days[0] < today ? days[0] : today;
    const thisWeek = startOfWeek(today, s.weekStartsOn);
    const isWorkingDay = (d: ISODate) => s.workingHours.days.includes(weekdayIndex(d));
    const history = Array.from({ length: 12 }, (_, i) => {
      const week = addDays(thisWeek, -7 * (11 - i));
      const total = weekTotal(activity, week);
      const hasTarget = goals.weeklyTasks !== null || goals.weeklyMinutes !== null;
      return { week, ...total, met: hasTarget ? (goals.weeklyTasks === null || total.completed >= goals.weeklyTasks) && (goals.weeklyMinutes === null || total.minutes >= goals.weeklyMinutes) : null };
    });
    const todayAct = activity.get(today) ?? { completed: 0, minutes: 0 };
    return {
      goals,
      today: todayAct,
      week: weekTotal(activity, thisWeek),
      todayMet: dayMeets(todayAct, goals),
      daily: dailyStreak(activity, goals, today, since, isWorkingDay),
      weekly: weeklyStreak(activity, goals, today, since, s.weekStartsOn),
      history,
    };
  }

  setGoals(goals: Goals): void {
    this.r.settings.set('goals', goalsSchema.parse(goals));
  }

  /** Time log for a range (newest first) for review and correction. */
  timeLog(range: DateRange) {
    const from = new Date(`${range.from}T00:00:00`).toISOString();
    const to = new Date(`${addDays(range.to, 1)}T00:00:00`).toISOString();
    return this.r.time.listBetween(from, to);
  }

  /** A timer left running a long time, for the user to confirm or trim. */
  longRunningTimer(): { entryId: string; taskId: string; minutes: number; startedAt: string } | null {
    const e = this.r.time.running();
    if (!e) return null;
    const minutes = entryMinutes(e, this.now());
    return minutes >= LONG_TIMER_MINUTES ? { entryId: e.id, taskId: e.taskId, minutes, startedAt: e.startedAt } : null;
  }
}
