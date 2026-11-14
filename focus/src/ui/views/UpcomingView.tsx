import { useMemo, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, diffDays, formatLongDate, startOfWeek, weekdayIndex, WEEKDAY_SHORT } from '@/core/dates';
import type { Task } from '@/core/domain/types';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { Button, IconButton, cx } from '../primitives';
import { AddTaskRow, GroupHeading, ViewBody } from '../components/common';
import { DRAG_MIME, TaskList } from '../components/TaskList';
import { ViewHeader } from '../layout/Chrome';

export function UpcomingView() {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const [start, setStart] = useState(today);
  const [days, setDays] = useState(14);
  const end = addDays(start, days - 1);
  const tasks = useQuery(() => app.repos.tasks.listBetween(start, end), [start, end]);
  const overdue = useQuery(
    () => (start <= today ? app.repos.tasks.listToday(today).filter((t) => (t.scheduledDate ?? t.deadline ?? today) < today) : []),
    [today, start],
  );
  const [dropDay, setDropDay] = useState<string | null>(null);

  // Each task is listed once: on its scheduled date if in range, otherwise on its deadline.
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      const day = t.scheduledDate && t.scheduledDate >= start && t.scheduledDate <= end ? t.scheduledDate : t.deadline!;
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(t);
    }
    return m;
  }, [tasks, start, end]);

  const weekStart = startOfWeek(start, prefs.weekStartsOn);
  const strip = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dayList = Array.from({ length: days }, (_, i) => addDays(start, i));

  return (
    <>
      <ViewHeader
        title="Upcoming"
        icon={<CalendarRange size={22} className="text-violet-500" />}
        actions={
          <>
            <IconButton label="Previous week" onClick={() => setStart((s) => (diffDays(s, today) <= 7 ? today : addDays(s, -7)))} disabled={start <= today}>
              <ChevronLeft size={18} />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => setStart(today)}>
              Today
            </Button>
            <IconButton label="Next week" onClick={() => setStart((s) => addDays(startOfWeek(s, prefs.weekStartsOn), 7))}>
              <ChevronRight size={18} />
            </IconButton>
          </>
        }
      />
      <ViewBody>
        <div className="mb-2 grid grid-cols-7 gap-1" role="list" aria-label="Week">
          {strip.map((d) => {
            const count = byDay.get(d)?.length ?? 0;
            return (
              <button
                key={d}
                type="button"
                role="listitem"
                disabled={d < today}
                onClick={() => document.getElementById(`day-${d}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={cx(
                  'flex flex-col items-center rounded-lg py-1.5 text-[0.78rem] disabled:opacity-40',
                  d === today ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2',
                )}
              >
                <span className="opacity-75">{WEEKDAY_SHORT[weekdayIndex(d)]}</span>
                <span className="text-[1rem] font-semibold">{Number(d.slice(8))}</span>
                <span className={cx('h-1 w-1 rounded-full', count ? (d === today ? 'bg-accent-fg' : 'bg-accent') : 'bg-transparent')} />
              </button>
            );
          })}
        </div>

        {overdue.length > 0 && (
          <GroupHeading title="Overdue" tone="danger" count={overdue.length} collapsible>
            <TaskList tasks={overdue} tree={false} showProject ariaLabel="Overdue" />
          </GroupHeading>
        )}

        {dayList.map((d) => {
          const list = byDay.get(d) ?? [];
          return (
            <div key={d} id={`day-${d}`} className="scroll-mt-20">
              <GroupHeading
                title={
                  <>
                    {d === today ? 'Today · ' : d === addDays(today, 1) ? 'Tomorrow · ' : ''}
                    <span className="font-normal text-muted">{formatLongDate(d, prefs)}</span>
                  </>
                }
                count={list.length || undefined}
                highlight={dropDay === d}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(DRAG_MIME)) {
                    e.preventDefault();
                    setDropDay(d);
                  }
                }}
                onDrop={(e) => {
                  setDropDay(null);
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  if (id) act(() => app.tasks.update(id, { scheduledDate: d }));
                }}
              >
                <TaskList tasks={list} tree={false} showProject hideDate draggable ariaLabel={`Tasks for ${formatLongDate(d, prefs)}`} />
                <AddTaskRow defaults={{ scheduledDate: d }} />
              </GroupHeading>
            </div>
          );
        })}
        <div className="mt-6 flex justify-center">
          <Button onClick={() => setDays((n) => n + 14)}>Show two more weeks</Button>
        </div>
      </ViewBody>
    </>
  );
}
