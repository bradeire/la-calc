import { useEffect } from 'react';
import { BellRing, Check, Clock, X } from 'lucide-react';
import { describeReminder, ReminderScheduler } from '@/app/reminder-scheduler';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useIsDesktop, useQuery } from '../hooks';
import { isOpenStatus } from '@/core/domain/types';
import { openTask } from '../router';
import { cx } from '../primitives';

const minutesUntilTomorrow9 = () => {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return Math.round((t.getTime() - now.getTime()) / 60000);
};

/** Runs the reminder scheduler for the life of the app and routes notification actions. */
export function useReminderDelivery() {
  const app = useApp();
  const act = useAction();
  useEffect(() => {
    const ui = useUi.getState();
    const scheduler = new ReminderScheduler(app, (items) => {
      ui.addReminders(items);
      const s = app.repos.settings.getAll();
      if (!s.notificationsEnabled) return;
      const missed = items.filter((i) => i.missed);
      const fresh = items.filter((i) => !i.missed);
      for (const d of fresh) void app.platform.notifications.show({ id: d.reminder.id, ...describeReminder(d, s.hour12) });
      // Missed reminders are summarised in one notification instead of a burst.
      if (missed.length === 1) void app.platform.notifications.show({ id: missed[0]!.reminder.id, ...describeReminder(missed[0]!, s.hour12) });
      else if (missed.length > 1) void app.platform.notifications.show({ id: 'missed', title: `${missed.length} missed reminders`, body: 'Open Focus to review them.' });
    });
    const stop = scheduler.start();
    const off = app.platform.notifications.onAction(({ reminderId, action }) => {
      const r = app.repos.reminders.get(reminderId);
      if (!r) return;
      if (action === 'complete') act((force) => app.tasks.complete(r.taskId, { force }));
      else if (action === 'snooze') act(() => app.reminders.snooze(reminderId, 10));
      else openTask(r.taskId);
      useUi.getState().removeReminder(reminderId);
    });
    return () => {
      stop();
      off();
    };
  }, [app, act]);
}

export function ReminderPanel() {
  const app = useApp();
  const act = useAction();
  const all = useUi((s) => s.activeReminders);
  const remove = useUi((s) => s.removeReminder);
  const isDesktop = useIsDesktop();
  // Hide reminders whose task has since been completed or deleted (e.g. via a confirmation prompt).
  const items = useQuery(() => all.filter((d) => {
    const t = app.repos.tasks.get(d.task.id);
    return !!t && !t.deletedAt && isOpenStatus(t.status);
  }), [all]);
  if (!items.length) return null;
  const hour12 = app.repos.settings.getAll().hour12;
  const snooze = (id: string, minutes: number, label: string) => {
    if (act(() => app.reminders.snooze(id, minutes), { success: `Snoozed ${label}` }) !== undefined) remove(id);
  };
  return (
    <section
      aria-label="Reminders"
      aria-live="assertive"
      className={cx('fixed z-[75] flex flex-col gap-2', isDesktop ? 'top-3 right-3 w-[360px]' : 'pt-safe inset-x-2 top-2')}
    >
      {items.slice(0, 4).map((d) => {
        const text = describeReminder(d, hour12);
        return (
          <div key={d.reminder.id} role="alertdialog" aria-label={`Reminder: ${d.task.title}`} className="anim-pop rounded-xl border border-line bg-surface p-3 shadow-pop">
            <div className="flex items-start gap-2">
              <BellRing size={17} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (openTask(d.task.id), remove(d.reminder.id))}>
                <span className="block font-medium leading-snug">{text.title}</span>
                <span className="block text-[0.8rem] text-muted">{text.body}</span>
              </button>
              <button type="button" aria-label="Dismiss reminder" className="text-subtle hover:text-fg" onClick={() => (act(() => app.reminders.dismiss(d.reminder.id)), remove(d.reminder.id))}>
                <X size={16} />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[0.82rem] font-medium text-accent-fg"
                onClick={() => {
                  if (act((force) => app.tasks.complete(d.task.id, { force })) !== undefined) remove(d.reminder.id);
                }}
              >
                <Check size={13} /> Complete
              </button>
              {([[10, 'for 10 minutes', '10 min'], [60, 'for an hour', '1 hour'], [minutesUntilTomorrow9(), 'until tomorrow 09:00', 'Tomorrow']] as const).map(([m, label, short]) => (
                <button key={short} type="button" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[0.82rem] hover:bg-surface-2" onClick={() => snooze(d.reminder.id, m, label)}>
                  <Clock size={12} /> {short}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {items.length > 4 && <p className="rounded-lg bg-surface px-3 py-1.5 text-center text-[0.8rem] text-muted shadow-card">+{items.length - 4} more reminders</p>}
    </section>
  );
}

/** Runs time-based automations every minute and shows "notify" actions. */
export function useAutomationRunner() {
  const app = useApp();
  useEffect(() => {
    const ui = useUi.getState();
    app.automations.setNotifier((title, body) => {
      ui.pushToast({ message: `${title}: ${body}` });
      if (app.repos.settings.getAll().notificationsEnabled) void app.platform.notifications.show({ id: `auto-${title}-${body}`.slice(0, 120), title, body });
    });
    const sweep = () => {
      try {
        // With sync on, time-based automations run on one chosen device so they don't fire twice.
        if (app.sync.runsTimedAutomations()) app.automations.sweep();
      } catch (err) {
        console.error('Automation sweep failed', err);
      }
    };
    const first = setTimeout(sweep, 1500);
    const timer = setInterval(sweep, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [app]);
}
