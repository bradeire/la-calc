import { addDays, todayISO, type ISODate } from '@/core/dates';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { busyMinutesByDay } from '@/core/ics';
import { findConflicts, suggestSchedule, workload, type Conflict, type DayLoad, type SchedulingOptions, type Suggestion } from '@/core/scheduling';
import type { Repositories } from '@/data';
import type { UndoAction } from './events';
import type { TaskService } from './task-service';

/** Connects the pure scheduling engine to stored tasks and settings (spec 4.2–4.3). */
export class PlanningService {
  constructor(
    private r: Repositories,
    private tasks: TaskService,
    private now: () => Date = () => new Date(),
  ) {}

  options(horizonDays = 21): SchedulingOptions {
    const s = this.r.settings.getAll();
    const today = todayISO(this.now());
    const end = addDays(today, Math.max(horizonDays, 60));
    // External calendar events (from calendars set to block time) reduce available time.
    const events = this.r.calendars.eventsBetween(today, end, { only: 'blocking' });
    const busy = busyMinutesByDay(events, s.workingHours, today, end);
    return { today, hours: s.workingHours, defaultEstimate: s.defaultEstimate, horizonDays, busy, events };
  }

  private openTasks(): Task[] {
    // Subtasks count toward load only when scheduled on their own.
    return this.r.tasks.listForFilters().filter((t) => isOpenStatus(t.status));
  }

  workload(from: ISODate, to: ISODate): DayLoad[] {
    return workload(this.openTasks(), from, to, this.options());
  }

  conflicts(): Conflict[] {
    return findConflicts(this.openTasks(), this.r.dependencies.all(), this.options());
  }

  suggestions(): Suggestion[] {
    return suggestSchedule(this.openTasks(), this.r.dependencies.all(), this.options());
  }

  /** Apply suggestions in one transaction; one undo restores every moved task. */
  accept(suggestions: readonly Suggestion[], opts: { force?: boolean } = {}): UndoAction {
    return this.r.db.transaction(() => {
      const before = suggestions.map((s) => ({ id: s.taskId, date: this.r.tasks.get(s.taskId)?.scheduledDate ?? null }));
      for (const s of suggestions) this.tasks.update(s.taskId, { scheduledDate: s.to }, opts);
      return {
        label: suggestions.length === 1 ? 'Task rescheduled' : `${suggestions.length} tasks rescheduled`,
        undo: () => this.r.db.transaction(() => before.forEach((b) => this.tasks.update(b.id, { scheduledDate: b.date }, { force: true }))),
      };
    });
  }

  /** Total minutes planned per day for the next `days` days from today. */
  horizon(days = 14): DayLoad[] {
    const today = todayISO(this.now());
    return this.workload(today, addDays(today, days - 1));
  }
}
