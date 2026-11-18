import { effectiveTime, isDue } from '@/core/reminders';
import type { Reminder, Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import { NotFoundError, ValidationError } from './events';

export interface DueReminder {
  reminder: Reminder;
  task: Task;
  /** True when it should have fired more than `missedAfterMinutes` ago (e.g. the app was closed). */
  missed: boolean;
}

/**
 * Reminder state machine: due → delivered → (snoozed → due again) | dismissed.
 * Delivery is done by the platform's notification adapter; this service only decides what is due.
 */
export class ReminderService {
  constructor(private r: Repositories) {}

  /** Reminders due now, oldest first. Does not change state. */
  due(now: Date, missedAfterMinutes = 15): DueReminder[] {
    const out: DueReminder[] = [];
    for (const rem of this.r.reminders.listActive()) {
      const task = this.r.tasks.get(rem.taskId);
      if (!task || !isDue(rem, task, now)) continue;
      const at = effectiveTime(rem, task)!;
      out.push({ reminder: rem, task, missed: now.getTime() - at.getTime() > missedAfterMinutes * 60000 });
    }
    return out.sort((a, b) => effectiveTime(a.reminder, a.task)!.getTime() - effectiveTime(b.reminder, b.task)!.getTime());
  }

  /** The next instant any reminder becomes due, for precise timer scheduling. */
  nextDueAt(now: Date): Date | null {
    let best: Date | null = null;
    for (const rem of this.r.reminders.listActive()) {
      if (rem.deliveredAt) continue;
      const task = this.r.tasks.get(rem.taskId);
      const t = task ? effectiveTime(rem, task) : null;
      if (t && t > now && (!best || t < best)) best = t;
    }
    return best;
  }

  markDelivered(ids: readonly string[], now = new Date()) {
    this.r.db.transaction(() => ids.forEach((id) => this.r.reminders.setState(id, { deliveredAt: now.toISOString() })));
  }

  /** Returns the time the reminder will fire again. */
  snooze(id: string, minutes: number, now = new Date()): Date {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 7) throw new ValidationError('Snooze for between 1 minute and 7 days');
    if (!this.r.reminders.get(id)) throw new NotFoundError('That reminder');
    const until = new Date(now.getTime() + minutes * 60000);
    this.r.reminders.setState(id, { deliveredAt: null, snoozedUntil: until.toISOString() });
    return until;
  }

  dismiss(id: string, now = new Date()): true {
    if (!this.r.reminders.get(id)) throw new NotFoundError('That reminder');
    this.r.reminders.setState(id, { dismissedAt: now.toISOString() });
    return true;
  }
}
