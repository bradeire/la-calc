import { formatTime } from '@/core/dates';
import type { DueReminder } from '@/services/reminder-service';
import type { AppContainer } from './container';

const MAX_WAIT_MS = 60_000;

/**
 * Delivers reminders while Focus is running: wakes exactly when the next one is
 * due (and at least once a minute), on returning to the foreground, and shortly
 * after data changes. Each reminder is marked delivered before it is shown, so
 * it can never fire twice.
 */
export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];

  constructor(
    private app: AppContainer,
    private deliver: (items: DueReminder[]) => void,
    private now: () => Date = () => new Date(),
  ) {}

  start(): () => void {
    this.cleanups.push(
      this.app.repos.db.subscribe(() => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.tick(), 500);
      }),
    );
    const onVisible = () => document.visibilityState === 'visible' && this.tick();
    document.addEventListener('visibilitychange', onVisible);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
    this.tick();
    return () => this.stop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
  }

  /** Deliver everything due now and schedule the next wake-up. Returns what was delivered. */
  tick(): DueReminder[] {
    const now = this.now();
    let due: DueReminder[] = [];
    try {
      due = this.app.reminders.due(now);
      if (due.length) {
        this.app.reminders.markDelivered(due.map((d) => d.reminder.id), now);
        this.deliver(due);
      }
    } catch (err) {
      console.error('Reminder check failed', err);
    }
    if (this.timer) clearTimeout(this.timer);
    const next = this.app.reminders.nextDueAt(now);
    const wait = next ? Math.min(MAX_WAIT_MS, Math.max(1000, next.getTime() - now.getTime() + 250)) : MAX_WAIT_MS;
    this.timer = setTimeout(() => this.tick(), wait);
    return due;
  }
}

/** Notification text for a due reminder. */
export function describeReminder(d: DueReminder, hour12: boolean): { title: string; body: string } {
  const t = d.task;
  const when = t.scheduledDate
    ? `${t.scheduledTime ? formatTime(t.scheduledTime, { dateOrder: 'dmy', hour12, weekStartsOn: 1 }) + ' · ' : ''}scheduled ${t.scheduledDate}`
    : t.deadline
      ? `deadline ${t.deadline}`
      : '';
  return { title: t.title, body: [d.missed ? 'Missed while Focus was closed' : 'Reminder', when].filter(Boolean).join(' — ') };
}
