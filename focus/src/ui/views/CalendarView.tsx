import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CalendarClock } from 'lucide-react';
import { addDays, addMonths, endOfMonth, formatLongDate, formatTime, fromISODate, MONTH_NAMES, startOfMonth, startOfWeek, WEEKDAY_SHORT } from '@/core/dates';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { previewOccurrences } from '@/core/recurrence/engine';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useDatePrefs, useIsDesktop, useQuery, useToday } from '../hooks';
import { openTask } from '../router';
import { Button, IconButton, cx } from '../primitives';
import { DRAG_MIME, TaskList } from '../components/TaskList';
import { PRIORITY_COLOR } from '../components/meta';
import { ViewHeader } from '../layout/Chrome';
import { ViewBody } from '../components/common';

interface Entry {
  task: Task;
  kind: 'scheduled' | 'deadline' | 'repeat';
}

/**
 * Month calendar (Phase 1). Shows scheduled tasks, deadlines separately, and
 * projected repeats of recurring tasks. Drag a task to another day to reschedule.
 * Day/3-day/week/agenda views with time blocks arrive in Phase 2.
 */
export function CalendarView({ embedded, projectId }: { embedded?: boolean; projectId?: string }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const isDesktop = useIsDesktop();
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const [month, setMonth] = useState(startOfMonth(today));
  const [selected, setSelected] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const gridStart = startOfWeek(month, prefs.weekStartsOn);
  const gridEnd = addDays(startOfWeek(endOfMonth(month), prefs.weekStartsOn), 6);
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) out.push(d);
    return out;
  }, [gridStart, gridEnd]);

  const tasks = useQuery(
    () => app.repos.tasks.listBetween(gridStart, gridEnd).filter((t) => !projectId || t.projectId === projectId),
    [gridStart, gridEnd, projectId],
  );
  const recurring = useQuery(
    () =>
      app.repos.db
        .all<{ id: string }>(
          `SELECT t.id FROM tasks t JOIN recurrence_rules r ON r.task_id = t.id WHERE t.deleted_at IS NULL
           AND t.status IN ('inbox','active','in_progress','waiting') AND t.scheduled_date <= ?`,
          [gridEnd],
        )
        .map((r) => app.repos.tasks.get(r.id)!)
        .filter((t) => t && (!projectId || t.projectId === projectId)),
    [gridEnd, projectId],
  );

  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    const add = (d: string, e: Entry) => {
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(e);
    };
    for (const t of tasks) {
      if (t.scheduledDate && t.scheduledDate >= gridStart && t.scheduledDate <= gridEnd) add(t.scheduledDate, { task: t, kind: 'scheduled' });
      if (t.deadline && t.deadline >= gridStart && t.deadline <= gridEnd && t.deadline !== t.scheduledDate) add(t.deadline, { task: t, kind: 'deadline' });
    }
    // Projected future occurrences (not yet created as tasks) shown faintly.
    for (const t of recurring) {
      if (!t.recurrence || !t.scheduledDate) continue;
      for (const d of previewOccurrences(t.recurrence, addDays(t.scheduledDate, 1), 45)) {
        if (d > gridEnd) break;
        if (d >= gridStart) add(d, { task: t, kind: 'repeat' });
      }
    }
    for (const list of m.values()) list.sort((a, b) => (a.task.scheduledTime ?? '99').localeCompare(b.task.scheduledTime ?? '99') || a.task.priority - b.task.priority);
    return m;
  }, [tasks, recurring, gridStart, gridEnd]);

  const monthDate = fromISODate(month);
  const title = `${MONTH_NAMES[monthDate.getMonth()]} ${monthDate.getFullYear()}`;
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(i + (prefs.weekStartsOn === 1 ? 0 : 6)) % 7]);
  const selectedTasks = selected ? (byDay.get(selected) ?? []).filter((e) => e.kind !== 'repeat').map((e) => e.task) : [];

  const nav = (
    <>
      <IconButton label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
        <ChevronLeft size={18} />
      </IconButton>
      <Button size="sm" variant="ghost" onClick={() => setMonth(startOfMonth(today))}>
        Today
      </Button>
      <IconButton label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
        <ChevronRight size={18} />
      </IconButton>
    </>
  );

  return (
    <>
      {!embedded && <ViewHeader title={title} icon={<CalendarDays size={22} className="text-warn" />} actions={nav} />}
      <ViewBody wide>
        {embedded && (
          <div className="mb-2 flex items-center gap-1">
            <h2 className="mr-auto text-[1.05rem] font-semibold">{title}</h2>
            {nav}
          </div>
        )}
        <div className="grid grid-cols-7 border-t border-l border-line text-[0.75rem]" role="group" aria-label={title}>
          {weekdays.map((w) => (
            <div key={w} aria-hidden className="border-r border-b border-line bg-surface-2 px-1.5 py-1 font-medium text-muted">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const entries = byDay.get(d) ?? [];
            const inMonth = d.slice(0, 7) === month.slice(0, 7);
            const limit = isDesktop ? 4 : 3;
            return (
              <div
                key={d}
                onClick={() => setSelected(d)}
                onDoubleClick={() => openQuickAdd({ scheduledDate: d, projectId: projectId ?? null })}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_MIME)) {
                    e.preventDefault();
                    setDropDay(d);
                  }
                }}
                onDragLeave={() => setDropDay(null)}
                onDrop={(e) => {
                  setDropDay(null);
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  const kind = e.dataTransfer.getData('application/x-focus-kind');
                  if (id) act(() => app.tasks.update(id, kind === 'deadline' ? { deadline: d } : { scheduledDate: d }));
                }}
                className={cx(
                  'flex min-h-20 cursor-pointer flex-col gap-0.5 border-r border-b border-line p-1 outline-none lg:min-h-28',
                  !inMonth && 'bg-surface-2/50 text-subtle',
                  selected === d && 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]',
                  dropDay === d && 'ring-2 ring-inset ring-accent',
                )}
              >
                <button
                  type="button"
                  aria-label={`${formatLongDate(d, prefs)}${entries.length ? `, ${entries.length} item${entries.length > 1 ? 's' : ''}` : ''}`}
                  aria-pressed={selected === d}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelected(d);
                  }}
                  className={cx('flex h-6 w-6 items-center justify-center self-start rounded-full text-[0.8rem]', d === today && 'bg-accent font-semibold text-accent-fg', d < today && d !== today && 'text-subtle')}
                >
                  {Number(d.slice(8))}
                </button>
                {entries.slice(0, limit).map((e, i) => (
                  <button
                    key={`${e.task.id}-${e.kind}-${i}`}
                    type="button"
                    draggable={e.kind !== 'repeat'}
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData(DRAG_MIME, e.task.id);
                      ev.dataTransfer.setData('application/x-focus-kind', e.kind);
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      openTask(e.task.id);
                    }}
                    title={`${e.kind === 'deadline' ? 'Deadline: ' : e.kind === 'repeat' ? 'Repeats: ' : ''}${e.task.title}`}
                    className={cx(
                      'flex items-center gap-1 truncate rounded px-1 py-px text-left leading-tight',
                      e.kind === 'deadline' ? 'border border-dashed border-warn text-warn' : 'bg-surface-2 hover:bg-surface-3',
                      e.kind === 'repeat' && 'border border-dotted border-line-strong bg-transparent text-muted italic',
                      !isOpenStatus(e.task.status) && 'line-through opacity-60',
                      e.kind === 'scheduled' && e.task.scheduledDate! < today && 'text-danger',
                    )}
                  >
                    {e.kind === 'deadline' ? <CalendarClock size={10} className="shrink-0" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[e.task.priority] }} />}
                    {e.kind === 'scheduled' && e.task.scheduledTime && <span className="shrink-0 text-muted">{formatTime(e.task.scheduledTime, prefs)}</span>}
                    <span className="truncate max-sm:hidden">{e.task.title}</span>
                  </button>
                ))}
                {entries.length > limit && <span className="px-1 text-subtle">+{entries.length - limit} more</span>}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[0.75rem] text-subtle">
          Dashed items are deadlines; dotted, italic items are upcoming repeats. Drag to reschedule; double-click a day to add a task.
        </p>
        {selected && (
          <section className="mt-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{formatLongDate(selected, prefs)}</h2>
              <Button size="sm" variant="ghost" onClick={() => openQuickAdd({ scheduledDate: selected, projectId: projectId ?? null })}>
                Add task on this day
              </Button>
            </div>
            <TaskList tasks={selectedTasks} tree={false} showProject={!projectId} draggable ariaLabel={`Tasks on ${selected}`} />
            {selectedTasks.length === 0 && <p className="py-4 text-[0.88rem] text-muted">Nothing on this day.</p>}
          </section>
        )}
      </ViewBody>
    </>
  );
}
