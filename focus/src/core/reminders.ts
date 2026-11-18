import type { Reminder, Task } from './domain/types';

/** Time used for relative reminders when the task has a date but no time. */
export const DEFAULT_REMINDER_TIME = '09:00';

/**
 * When a reminder should fire, as a local instant.
 *  - absolute: its stored instant
 *  - relative: `offsetMinutes` before the scheduled date/time, or before the deadline (at the default time)
 * Returns null when a relative reminder has nothing to be relative to.
 */
export function fireTime(r: Reminder, task: Pick<Task, 'scheduledDate' | 'scheduledTime' | 'deadline'>, defaultTime = DEFAULT_REMINDER_TIME): Date | null {
  if (r.kind === 'absolute') return r.remindAt ? new Date(r.remindAt) : null;
  const date = task.scheduledDate ?? task.deadline;
  if (!date) return null;
  const time = (task.scheduledDate && task.scheduledTime) || defaultTime;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const at = new Date(y!, m! - 1, d!, hh!, mm!);
  return new Date(at.getTime() - (r.offsetMinutes ?? 0) * 60000);
}

/** The instant the reminder is next due: its snooze time if snoozed, otherwise its fire time. */
export function effectiveTime(r: Reminder, task: Pick<Task, 'scheduledDate' | 'scheduledTime' | 'deadline'>): Date | null {
  return r.snoozedUntil ? new Date(r.snoozedUntil) : fireTime(r, task);
}

/** Due = not dismissed, not yet delivered (since its last snooze), and its time has come. */
export function isDue(r: Reminder, task: Pick<Task, 'scheduledDate' | 'scheduledTime' | 'deadline'>, now: Date): boolean {
  if (r.dismissedAt || r.deliveredAt) return false;
  const t = effectiveTime(r, task);
  return !!t && t.getTime() <= now.getTime();
}
