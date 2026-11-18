import { useEffect, useMemo, useState } from 'react';
import { Clock, Pencil, Square, Trash2 } from 'lucide-react';
import { formatDuration, formatLongDate, formatTime, toISODate, type ISODate } from '@/core/dates';
import type { TimeEntry } from '@/core/domain/types';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useDatePrefs, useIsDesktop, useQuery, useSettings } from '../hooks';
import { Button, Dialog, Field, IconButton, Input, Select } from '../primitives';
import { ViewHeader } from '../layout/Chrome';
import { ViewBody } from '../components/common';
import { go, openTask, useLocation } from '../router';
import { rangeFor } from './InsightsView';

const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const combine = (day: ISODate, time: string) => new Date(`${day}T${time}:00`).toISOString();

function EditEntryDialog({ entry, onClose }: { entry: TimeEntry | null; onClose: () => void }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!entry) return;
    setDay(toISODate(new Date(entry.startedAt)));
    setTime(localTime(entry.startedAt));
    setMinutes(String(entry.minutes ?? 0));
    setNote(entry.note);
  }, [entry]);
  const save = () => {
    try {
      app.tasks.correctTimeEntry(entry!.id, { startedAt: combine(day, time), minutes: Number(minutes), note });
      pushToast({ message: 'Time entry corrected', tone: 'success' });
      onClose();
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <Dialog
      open={!!entry}
      onClose={onClose}
      title="Correct time entry"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Date" htmlFor="te-day">
          <Input id="te-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Start" htmlFor="te-time">
          <Input id="te-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="Minutes" htmlFor="te-min">
          <Input id="te-min" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
        <div className="sm:col-span-3">
          <Field label="Note" htmlFor="te-note">
            <Input id="te-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Running timer with "stop now" and "stop at an earlier time" (an active timer ≠ working). */
function RunningTimer() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const prefs = useDatePrefs();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const running = useQuery(() => app.repos.time.running() ?? null, [tick]);
  const [end, setEnd] = useState('');
  if (!running) return null;
  const task = app.repos.tasks.get(running.taskId);
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(running.startedAt)) / 60000));
  const stopAt = () => {
    try {
      const startDay = toISODate(new Date(running.startedAt));
      let at = combine(startDay, end);
      if (Date.parse(at) < Date.parse(running.startedAt)) at = combine(toISODate(new Date()), end);
      const m = app.tasks.stopTimerAt(at);
      pushToast({ message: `Timer stopped: ${formatDuration(m)} recorded`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <section aria-label="Running timer" className="mb-6 rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-[0.95rem]">
        <Clock size={16} className="text-accent" />
        <span className="min-w-0 flex-1 truncate">
          Timer running on <strong>{task?.title ?? 'a task'}</strong> since {formatTime(localTime(running.startedAt), prefs)} ({formatDuration(mins)})
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" onClick={() => app.tasks.stopTimer()}>
          <Square size={13} /> Stop now
        </Button>
        <Field label="Or stop at" htmlFor="stop-at">
          <Input id="stop-at" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-32" />
        </Field>
        <Button size="sm" disabled={!end} onClick={stopAt}>
          Stop at this time
        </Button>
      </div>
    </section>
  );
}

export function TimeLogView() {
  const app = useApp();
  const settings = useSettings();
  const prefs = useDatePrefs();
  const askConfirm = useUi((s) => s.askConfirm);
  const [preset, setPreset] = useState<'7' | '30' | 'month' | '90'>('7');
  const range = rangeFor(preset, app.insights.today(), settings.weekStartsOn);
  const entries = useQuery(() => app.insights.timeLog(range).filter((e) => e.endedAt !== null), [range.from, range.to]);
  const titles = useQuery(() => new Map(app.repos.tasks.getMany([...new Set(entries.map((e) => e.taskId))]).map((t) => [t.id, t.title])), [entries]);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const days = useMemo(() => {
    const m = new Map<ISODate, TimeEntry[]>();
    for (const e of entries) {
      const d = toISODate(new Date(e.startedAt));
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return [...m];
  }, [entries]);
  const total = entries.reduce((s, e) => s + (e.minutes ?? 0), 0);
  return (
    <>
      <ViewHeader title="Time log" subtitle={`${formatDuration(total)} in this period`} icon={<Clock size={22} className="text-accent" />} actions={<Button size="sm" variant="ghost" onClick={() => go({ name: 'insights' })}>Insights</Button>} />
      <ViewBody>
        <RunningTimer />
        <div className="mb-4 max-w-56">
          <Field label="Period" htmlFor="time-range">
            <Select id="time-range" value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="month">This month</option>
              <option value="90">Last 90 days</option>
            </Select>
          </Field>
        </div>
        {days.length === 0 && <p className="text-muted">No time recorded in this period. Use the timer in Focus mode or “Add time” in a task’s details.</p>}
        {days.map(([day, list]) => (
          <section key={day} className="mb-5" aria-label={formatLongDate(day, prefs)}>
            <h2 className="mb-1 flex justify-between text-[0.9rem] font-semibold">
              <span>{formatLongDate(day, prefs)}</span>
              <span className="tabular-nums text-muted">{formatDuration(list.reduce((s, e) => s + (e.minutes ?? 0), 0))}</span>
            </h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {list.map((e) => (
                <li key={e.id} className="flex items-center gap-2 px-3 py-2 text-[0.88rem]">
                  <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openTask(e.taskId)}>
                    {titles.get(e.taskId) ?? 'Deleted task'}
                    {e.note && <span className="text-muted"> · {e.note}</span>}
                  </button>
                  <span className="hidden text-muted tabular-nums sm:inline">
                    {formatTime(localTime(e.startedAt), prefs)}–{e.endedAt ? formatTime(localTime(e.endedAt), prefs) : ''}
                  </span>
                  <span className="w-14 text-right tabular-nums">{formatDuration(e.minutes ?? 0)}</span>
                  <span className="hidden w-14 text-[0.75rem] text-subtle sm:inline">{e.source === 'manual' ? 'manual' : 'timer'}</span>
                  <IconButton size="sm" label="Correct entry" onClick={() => setEditing(e)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label="Delete entry"
                    onClick={() =>
                      askConfirm({ message: 'Delete this time entry? The task’s tracked total will be updated.', confirmLabel: 'Delete', onConfirm: () => app.tasks.deleteTimeEntry(e.id) })
                    }
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </ViewBody>
      <EditEntryDialog entry={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** Global prompt when a timer has run for hours: it may have been left running. */
export function LongTimerPrompt() {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const long = useQuery(() => app.insights.longRunningTimer(), [tick]);
  const loc = useLocation();
  const isDesktop = useIsDesktop();
  // On phones the task sheet is modal (and has its own Stop button); ask once it closes.
  if (!long || dismissed === long.entryId || (loc.taskId && !isDesktop)) return null;
  const title = app.repos.tasks.get(long.taskId)?.title ?? 'a task';
  return (
    <div role="alert" className="fixed inset-x-3 bottom-24 z-40 mx-auto max-w-lg rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow-lg)] lg:bottom-6">
      <p className="mb-2 text-[0.9rem]">
        The timer on <strong>{title}</strong> has been running for {formatDuration(long.minutes)}. Are you still working on it?
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => setDismissed(long.entryId)}>
          Yes, keep it running
        </Button>
        <Button size="sm" onClick={() => app.tasks.stopTimer()}>
          Stop now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (setDismissed(long.entryId), go({ name: 'timeLog' }))}>
          Fix the end time
        </Button>
      </div>
    </div>
  );
}
