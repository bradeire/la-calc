import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import { fromHHMM, layoutDay, snap, toHHMM } from '@/core/calendar-layout';
import {
  addDays, addMonths, endOfMonth, formatDuration, formatLongDate, formatTime, fromISODate, MONTH_NAMES, MONTH_SHORT, startOfMonth,
  startOfWeek, weekdayIndex, WEEKDAY_SHORT, type ISODate,
  toISODate,
} from '@/core/dates';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { previewOccurrences } from '@/core/recurrence/engine';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useDatePrefs, useIsDesktop, useQuery, useSettings, useToday } from '../hooks';
import { openTask } from '../router';
import { Button, IconButton, Select, cx } from '../primitives';
import { DRAG_MIME, TaskList } from '../components/TaskList';
import { PRIORITY_COLOR } from '../components/meta';
import { ViewHeader } from '../layout/Chrome';
import { GroupHeading, ViewBody } from '../components/common';

type CalView = 'day' | '3day' | 'week' | 'month' | 'agenda';
const VIEW_LABELS: Record<CalView, string> = { day: 'Day', '3day': '3 days', week: 'Week', month: 'Month', agenda: 'Agenda' };
const HOUR_PX = 48;
const DEFAULT_BLOCK_MIN = 30;

interface Entry {
  task: Task;
  date: ISODate;
  kind: 'scheduled' | 'deadline' | 'repeat';
}

/** Read-only events from external calendars (Settings → Calendars). */
interface ExtEvent {
  id: string;
  title: string;
  location: string;
  calendar: string;
  color: string;
  allDay: boolean;
  start: string;
  end: string;
}
interface ExtDay {
  allDay: ExtEvent[];
  /** Minutes from local midnight, clipped to the day. */
  timed: { ev: ExtEvent; start: number; end: number }[];
}
function bucketEvents(events: readonly ExtEvent[], from: ISODate, to: ISODate): Map<ISODate, ExtDay> {
  const m = new Map<ISODate, ExtDay>();
  const get = (d: ISODate) => m.get(d) ?? (m.set(d, { allDay: [], timed: [] }), m.get(d)!);
  for (const ev of events) {
    if (ev.allDay) {
      for (let d = ev.start < from ? from : ev.start; d < ev.end && d <= to; d = addDays(d, 1)) get(d).allDay.push(ev);
      continue;
    }
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    for (let d = toISODate(s) < from ? from : toISODate(s); d <= to; d = addDays(d, 1)) {
      const [y, mo, da] = d.split('-').map(Number) as [number, number, number];
      const dayStart = new Date(y, mo - 1, da).getTime();
      if (dayStart >= e.getTime()) break;
      const a = Math.max(0, (s.getTime() - dayStart) / 60000);
      const b = Math.min(24 * 60, (e.getTime() - dayStart) / 60000);
      if (b > a) get(d).timed.push({ ev, start: a, end: b });
    }
  }
  return m;
}

function EventChip({ ev, time }: { ev: ExtEvent; time?: string }) {
  return (
    <div
      title={`${ev.title}${ev.location ? ` · ${ev.location}` : ''} (${ev.calendar})`}
      className="flex items-center gap-1 truncate rounded px-1 py-px text-left leading-tight"
      style={{ background: `color-mix(in srgb, ${ev.color} 16%, var(--surface))`, borderLeft: `3px solid ${ev.color}` }}
    >
      {time && <span className="shrink-0 text-muted">{time}</span>}
      <span className="truncate">{ev.title}</span>
    </div>
  );
}

function readView(isDesktop: boolean): CalView {
  try {
    const v = localStorage.getItem('focus.ui.calendarView') as CalView | null;
    if (v && v in VIEW_LABELS) return v;
  } catch {
    // storage unavailable; fall through to the default
  }
  return isDesktop ? 'week' : 'day';
}

function rangeFor(view: CalView, anchor: ISODate, weekStartsOn: 0 | 1): [ISODate, ISODate] {
  switch (view) {
    case 'day': return [anchor, anchor];
    case '3day': return [anchor, addDays(anchor, 2)];
    case 'week': {
      const s = startOfWeek(anchor, weekStartsOn);
      return [s, addDays(s, 6)];
    }
    case 'month': return [startOfWeek(startOfMonth(anchor), weekStartsOn), addDays(startOfWeek(endOfMonth(anchor), weekStartsOn), 6)];
    case 'agenda': return [anchor, addDays(anchor, 29)];
  }
}

/** Calendar (spec 4.1): day, 3-day, week, month and agenda; drag to reschedule, resize to change duration. */
export function CalendarView({ embedded, projectId }: { embedded?: boolean; projectId?: string }) {
  const app = useApp();
  const today = useToday();
  const prefs = useDatePrefs();
  const isDesktop = useIsDesktop();
  const [view, setViewState] = useState<CalView>(() => readView(isDesktop));
  const [anchor, setAnchor] = useState(today);
  const [projectFilter, setProjectFilter] = useState<string>(projectId ?? '');
  const [labelFilter, setLabelFilter] = useState('');
  const setView = (v: CalView) => {
    setViewState(v);
    try {
      localStorage.setItem('focus.ui.calendarView', v);
    } catch {
      // preference not remembered in private mode
    }
  };
  const [from, to] = rangeFor(view, anchor, prefs.weekStartsOn);
  const projects = useQuery(() => app.repos.projects.list(), []);
  const labels = useQuery(() => app.repos.labels.list(), []);
  const allowedProjects = useQuery(
    () => (projectFilter ? new Set([projectFilter, ...app.repos.projects.descendantIds(projectFilter)]) : null),
    [projectFilter],
  );
  const keep = (t: Task) => (!allowedProjects || (t.projectId !== null && allowedProjects.has(t.projectId))) && (!labelFilter || t.labelIds.includes(labelFilter));

  const tasks = useQuery(() => app.repos.tasks.listBetween(from, to).filter(keep), [from, to, allowedProjects, labelFilter]);
  const recurring = useQuery(
    () =>
      app.repos.db
        .all<{ id: string }>(
          `SELECT t.id FROM tasks t JOIN recurrence_rules r ON r.task_id = t.id WHERE t.deleted_at IS NULL
           AND t.status IN ('inbox','active','in_progress','waiting') AND t.scheduled_date <= ?`,
          [to],
        )
        .map((r) => app.repos.tasks.get(r.id)!)
        .filter((t) => t && keep(t)),
    [to, allowedProjects, labelFilter],
  );
  const entries = useMemo(() => {
    const m = new Map<ISODate, Entry[]>();
    const add = (e: Entry) => m.set(e.date, [...(m.get(e.date) ?? []), e]);
    for (const t of tasks) {
      if (t.scheduledDate && t.scheduledDate >= from && t.scheduledDate <= to) add({ task: t, date: t.scheduledDate, kind: 'scheduled' });
      if (t.deadline && t.deadline >= from && t.deadline <= to && t.deadline !== t.scheduledDate) add({ task: t, date: t.deadline, kind: 'deadline' });
    }
    for (const t of recurring) {
      if (!t.recurrence || !t.scheduledDate) continue;
      for (const d of previewOccurrences(t.recurrence, addDays(t.scheduledDate, 1), 60)) {
        if (d > to) break;
        if (d >= from) add({ task: t, date: d, kind: 'repeat' });
      }
    }
    return m;
  }, [tasks, recurring, from, to]);

  const external = useQuery(() => bucketEvents(app.calendars.events(from, to), from, to), [from, to]);

  const step = (dir: 1 | -1) => {
    if (view === 'month') setAnchor(addMonths(startOfMonth(anchor), dir));
    else setAnchor(addDays(anchor, dir * (view === 'day' ? 1 : view === '3day' ? 3 : view === 'week' ? 7 : 30)));
  };
  const a = fromISODate(anchor);
  const title =
    view === 'month'
      ? `${MONTH_NAMES[a.getMonth()]} ${a.getFullYear()}`
      : view === 'day'
        ? formatLongDate(anchor, prefs)
        : `${Number(from.slice(8))} ${MONTH_SHORT[fromISODate(from).getMonth()]} – ${Number(to.slice(8))} ${MONTH_SHORT[fromISODate(to).getMonth()]} ${to.slice(0, 4)}`;

  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Calendar view">
        {(Object.keys(VIEW_LABELS) as CalView[]).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)} className={cx('h-7 rounded-md px-2 text-[0.8rem]', view === v ? 'bg-surface-3 font-medium' : 'text-muted hover:text-fg')}>
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>
      <IconButton size="sm" label="Previous" onClick={() => step(-1)}>
        <ChevronLeft size={17} />
      </IconButton>
      <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
        Today
      </Button>
      <IconButton size="sm" label="Next" onClick={() => step(1)}>
        <ChevronRight size={17} />
      </IconButton>
      {!projectId && (
        <Select aria-label="Filter by project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className="h-8 max-w-40 text-[0.82rem]">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      )}
      <Select aria-label="Filter by label" value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} className="h-8 max-w-36 text-[0.82rem]">
        <option value="">All labels</option>
        {labels.map((l) => <option key={l.id} value={l.id}>@{l.name}</option>)}
      </Select>
    </div>
  );

  return (
    <>
      {!embedded && <ViewHeader title={title} icon={<CalendarDays size={22} className="text-warn" />} />}
      <ViewBody wide>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {embedded && <h2 className="text-[1.05rem] font-semibold">{title}</h2>}
          {controls}
        </div>
        {view === 'month' && <MonthGrid anchor={anchor} from={from} to={to} entries={entries} external={external} today={today} projectId={projectId} onPickDay={(d) => (setAnchor(d), setView('day'))} />}
        {view === 'agenda' && <Agenda from={from} entries={entries} external={external} today={today} />}
        {(view === 'day' || view === '3day' || view === 'week') && <TimeGrid from={from} to={to} entries={entries} external={external} today={today} projectId={projectId} />}
        <p className="mt-2 text-[0.75rem] text-subtle">
          Dashed items are deadlines; dotted italic items are future repeats; tinted items come from your other calendars (read-only). Drag a block to move it, drag its lower edge to change the duration
          {isDesktop ? '' : ' (touch: press and hold first)'}. Click an empty slot to add a task.
        </p>
      </ViewBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// Time grid (day / 3-day / week)
// ---------------------------------------------------------------------------

interface DragState {
  taskId: string;
  mode: 'move' | 'resize';
  startY: number;
  startX: number;
  origDate: ISODate;
  origStart: number;
  origDuration: number;
  date: ISODate;
  start: number;
  duration: number;
  moved: boolean;
  armed: boolean;
}

function TimeGrid({ from, to, entries, external, today, projectId }: { from: ISODate; to: ISODate; entries: Map<ISODate, Entry[]>; external: Map<ISODate, ExtDay>; today: ISODate; projectId?: string }) {
  const app = useApp();
  const act = useAction();
  const prefs = useDatePrefs();
  const settings = useSettings();
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const days = useMemo(() => {
    const out: ISODate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }, [from, to]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  useEffect(() => {
    const t = setInterval(() => setNowMin(new Date().getHours() * 60 + new Date().getMinutes()), 60000);
    return () => clearInterval(t);
  }, []);
  useLayoutEffect(() => {
    // Start scrolled to just before the working day.
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (fromHHMM(settings.workingHours.start) / 60 - 1) * HOUR_PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Block page scrolling on touch while a block is being dragged.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (dragRef.current?.armed) e.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  const workStart = fromHHMM(settings.workingHours.start);
  const workEnd = fromHHMM(settings.workingHours.end);
  const isWorkDay = (d: ISODate) => settings.workingHours.days.includes(weekdayIndex(d));

  const dayAtX = (clientX: number): ISODate | null => {
    const rect = colsRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const i = Math.floor(((clientX - rect.left) / rect.width) * days.length);
    return days[Math.max(0, Math.min(days.length - 1, i))] ?? null;
  };

  const update = (s: DragState) => {
    dragRef.current = s;
    setDrag(s);
  };

  const begin = (e: RPointerEvent, t: Task, mode: DragState['mode']) => {
    e.stopPropagation();
    const start = fromHHMM(t.scheduledTime!);
    const dur = t.durationMinutes ?? DEFAULT_BLOCK_MIN;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    update({
      taskId: t.id, mode, startY: e.clientY, startX: e.clientX, origDate: t.scheduledDate!, origStart: start, origDuration: dur,
      date: t.scheduledDate!, start, duration: dur, moved: false, armed: e.pointerType !== 'touch',
    });
    if (e.pointerType === 'touch') {
      // Press and hold to drag on touch, so a normal swipe still scrolls.
      holdTimer.current = setTimeout(() => {
        if (dragRef.current && !dragRef.current.moved) {
          navigator.vibrate?.(15);
          update({ ...dragRef.current, armed: true });
        }
      }, 350);
    }
  };
  const move = (e: RPointerEvent) => {
    const s = dragRef.current;
    if (!s) return;
    const dy = e.clientY - s.startY;
    const dx = e.clientX - s.startX;
    if (!s.armed) {
      if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        if (holdTimer.current) clearTimeout(holdTimer.current);
        update({ ...s, moved: true }); // became a scroll gesture
      }
      return;
    }
    const deltaMin = snap((dy / HOUR_PX) * 60);
    const moved = s.moved || Math.abs(dy) > 4 || Math.abs(dx) > 4;
    if (s.mode === 'resize') update({ ...s, moved, duration: Math.max(15, s.origDuration + deltaMin) });
    else update({ ...s, moved, start: Math.max(0, Math.min(24 * 60 - 15, s.origStart + deltaMin)), date: dayAtX(e.clientX) ?? s.date });
  };
  const end = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    const s = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!s) return;
    if (!s.moved) {
      openTask(s.taskId);
      return;
    }
    if (!s.armed) return;
    if (s.mode === 'resize' && s.duration !== s.origDuration) act(() => app.tasks.update(s.taskId, { durationMinutes: s.duration }));
    if (s.mode === 'move' && (s.date !== s.origDate || s.start !== s.origStart)) {
      act((force) => app.tasks.update(s.taskId, { scheduledDate: s.date, scheduledTime: toHHMM(s.start) }, { force }));
    }
  };

  const allDay = (d: ISODate) => (entries.get(d) ?? []).filter((e) => e.kind === 'deadline' || !e.task.scheduledTime);
  const timed = (d: ISODate) => (entries.get(d) ?? []).filter((e) => e.kind !== 'deadline' && e.task.scheduledTime);
  const gridCols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      {/* Day headers + all-day row */}
      <div className="flex border-b border-line">
        <div className="w-12 shrink-0 border-r border-line" />
        <div className="grid flex-1" style={gridCols}>
          {days.map((d) => (
            <div key={d} className="border-r border-line px-1 py-1 last:border-r-0">
              <div className={cx('text-center text-[0.78rem]', d === today ? 'font-semibold text-accent' : 'text-muted')}>
                {WEEKDAY_SHORT[weekdayIndex(d)]}{' '}
                <span className={cx('ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full', d === today && 'bg-accent text-accent-fg')}>{Number(d.slice(8))}</span>
              </div>
              <div
                className="mt-1 flex min-h-6 flex-col gap-0.5"
                role="group"
                aria-label={`All-day items for ${formatLongDate(d, prefs)}`}
                onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  if (id) act((force) => app.tasks.update(id, { scheduledDate: d, scheduledTime: null }, { force }));
                }}
              >
                {external.get(d)?.allDay.map((ev) => (
                  <div key={ev.id} className="text-[0.75rem]">
                    <EventChip ev={ev} />
                  </div>
                ))}
                {allDay(d).map((e, i) => (
                  <button
                    key={`${e.task.id}-${e.kind}-${i}`}
                    type="button"
                    draggable={e.kind === 'scheduled'}
                    onDragStart={(ev) => ev.dataTransfer.setData(DRAG_MIME, e.task.id)}
                    onClick={() => openTask(e.task.id)}
                    title={`${e.kind === 'deadline' ? 'Deadline: ' : ''}${e.task.title}`}
                    className={cx(
                      'flex items-center gap-1 truncate rounded px-1 py-px text-left text-[0.75rem]',
                      e.kind === 'deadline' ? 'border border-dashed border-warn text-warn' : e.kind === 'repeat' ? 'border border-dotted border-line-strong text-muted italic' : 'bg-surface-2 hover:bg-surface-3',
                      e.kind === 'scheduled' && e.date < today && 'text-danger',
                    )}
                  >
                    {e.kind === 'deadline' ? <CalendarClock size={10} className="shrink-0" /> : e.kind === 'repeat' ? <Repeat size={10} className="shrink-0" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[e.task.priority] }} />}
                    <span className="truncate">{e.task.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Hours */}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Timed tasks by hour (scroll for earlier or later times)"
        className="relative max-h-[calc(100dvh-15rem)] overflow-y-auto scrollbar-thin"
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          <div className="relative w-12 shrink-0 border-r border-line" aria-hidden>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[0.7rem] text-subtle" style={{ top: h * HOUR_PX }}>
                {h === 0 ? '' : formatTime(toHHMM(h * 60), prefs)}
              </div>
            ))}
          </div>
          <div ref={colsRef} className="relative grid flex-1" style={gridCols}>
            {days.map((d) => (
              <div
                key={d}
                data-day={d}
                className="relative border-r border-line last:border-r-0"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const y = e.nativeEvent.offsetY;
                  openQuickAdd({ scheduledDate: d, scheduledTime: toHHMM(Math.floor((y / HOUR_PX) * 2) * 30), projectId: projectId ?? null });
                }}
                onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  if (!id) return;
                  const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                  act((force) => app.tasks.update(id, { scheduledDate: d, scheduledTime: toHHMM(snap((y / HOUR_PX) * 60)) }, { force }));
                }}
              >
                {/* Non-working hours shading and hour lines (clicks pass through to the column) */}
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  {isWorkDay(d) ? (
                    <>
                      <div className="absolute inset-x-0 top-0 bg-surface-2/70" style={{ height: (workStart / 60) * HOUR_PX }} />
                      <div className="absolute inset-x-0 bottom-0 bg-surface-2/70" style={{ top: (workEnd / 60) * HOUR_PX }} />
                    </>
                  ) : (
                    <div className="absolute inset-0 bg-surface-2/70" />
                  )}
                  {Array.from({ length: 24 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-line/70" style={{ top: h * HOUR_PX }} />)}
                </div>
                {d === today && (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowMin / 60) * HOUR_PX }}>
                    <span className="absolute -top-[5px] -left-1 h-2 w-2 rounded-full bg-danger" />
                  </div>
                )}
                {/* External calendar events: background blocks (read-only); tasks sit on top. */}
                {layoutDay((external.get(d)?.timed ?? []).map((x) => ({ id: x.ev.id, start: x.start, end: Math.max(x.end, x.start + 15) }))).map((p) => {
                  const x = external.get(d)!.timed.find((t) => t.ev.id === p.id)!;
                  return (
                    <div
                      key={`ext-${p.id}`}
                      className="pointer-events-none absolute z-10 overflow-hidden rounded-md px-1.5 py-0.5 text-[0.72rem] leading-tight text-fg"
                      style={{
                        top: (p.start / 60) * HOUR_PX,
                        height: Math.max(((p.end - p.start) / 60) * HOUR_PX, 16),
                        left: `calc(${(p.column / p.columns) * 100}% + 1px)`,
                        width: `calc(${100 / p.columns}% - 2px)`,
                        background: `color-mix(in srgb, ${x.ev.color} 14%, var(--surface))`,
                        borderLeft: `3px solid ${x.ev.color}`,
                      }}
                    >
                      <span className="block truncate">
                        {x.ev.title}
                        <span className="sr-only">
                          {' '}
                          ({x.ev.calendar}, {formatTime(toHHMM(Math.round(x.start)), prefs)}–{formatTime(toHHMM(Math.round(x.end) % 1440), prefs)})
                        </span>
                      </span>
                    </div>
                  );
                })}
                {layoutDay(
                  timed(d).map((e) => {
                    const live = drag && drag.taskId === e.task.id && e.kind === 'scheduled' ? drag : null;
                    const start = live ? live.start : fromHHMM(e.task.scheduledTime!);
                    const dur = live ? live.duration : (e.task.durationMinutes ?? DEFAULT_BLOCK_MIN);
                    return { id: `${e.task.id}|${e.kind}`, start, end: start + Math.max(dur, 15) };
                  }),
                ).map((p) => {
                  const [taskId, kind] = p.id.split('|') as [string, Entry['kind']];
                  const e = timed(d).find((x) => x.task.id === taskId && x.kind === kind)!;
                  const t = e.task;
                  const isRepeat = kind === 'repeat';
                  const live = drag && drag.taskId === taskId && !isRepeat ? drag : null;
                  const away = !!live && live.armed && live.date !== d; // being dragged to another column
                  const height = ((p.end - p.start) / 60) * HOUR_PX;
                  return (
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${t.title}, ${formatTime(toHHMM(p.start), prefs)}, ${formatDuration(p.end - p.start)}`}
                      onKeyDown={(ev) => ev.key === 'Enter' && openTask(t.id)}
                      onPointerDown={isRepeat ? undefined : (ev) => begin(ev, t, 'move')}
                      onClick={isRepeat ? () => openTask(t.id) : undefined}
                      className={cx(
                        'absolute z-20 overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-[0.75rem] leading-tight shadow-sm select-none',
                        isRepeat ? 'border border-dotted border-line-strong bg-surface text-muted italic' : 'cursor-grab bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-fg',
                        live?.armed && 'cursor-grabbing shadow-pop ring-2 ring-accent',
                        away && 'opacity-30',
                        !isRepeat && d < today && 'bg-[color-mix(in_srgb,var(--danger)_12%,var(--surface))]',
                        !isOpenStatus(t.status) && 'line-through opacity-60',
                      )}
                      style={{
                        top: (p.start / 60) * HOUR_PX,
                        height: Math.max(height, 18),
                        left: `calc(${(p.column / p.columns) * 100}% + 2px)`,
                        width: `calc(${100 / p.columns}% - 4px)`,
                        borderLeftColor: PRIORITY_COLOR[t.priority],
                        touchAction: live?.armed ? 'none' : 'pan-y',
                      }}
                    >
                      <div className="truncate font-medium">{t.title}</div>
                      {height > 30 && (
                        <div className="truncate text-muted">
                          {formatTime(toHHMM(p.start), prefs)}–{formatTime(toHHMM(p.end), prefs)}
                        </div>
                      )}
                      {!isRepeat && <div aria-hidden onPointerDown={(ev) => begin(ev, t, 'resize')} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize hover:bg-accent/30" />}
                    </div>
                  );
                })}
                {/* Ghost of a block being dragged into this column from another day */}
                {drag && drag.armed && drag.mode === 'move' && drag.date === d && drag.origDate !== d && (
                  <div className="pointer-events-none absolute inset-x-0.5 z-30 rounded-md bg-accent/25 ring-2 ring-accent" style={{ top: (drag.start / 60) * HOUR_PX, height: (drag.duration / 60) * HOUR_PX }} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

function MonthGrid({ anchor, from, to, entries, external, today, projectId, onPickDay }: { anchor: ISODate; from: ISODate; to: ISODate; entries: Map<ISODate, Entry[]>; external: Map<ISODate, ExtDay>; today: ISODate; projectId?: string; onPickDay: (d: ISODate) => void }) {
  const app = useApp();
  const act = useAction();
  const prefs = useDatePrefs();
  const isDesktop = useIsDesktop();
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const days = useMemo(() => {
    const out: ISODate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }, [from, to]);
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(i + (prefs.weekStartsOn === 1 ? 0 : 6)) % 7]);
  return (
    <div className="grid grid-cols-7 border-t border-l border-line text-[0.75rem]" role="group" aria-label="Month">
      {weekdays.map((w) => (
        <div key={w} aria-hidden className="border-r border-b border-line bg-surface-2 px-1.5 py-1 font-medium text-muted">
          {w}
        </div>
      ))}
      {days.map((d) => {
        const list = entries.get(d) ?? [];
        const ext = external.get(d);
        const evs = [...(ext?.allDay ?? []).map((ev) => ({ ev, time: undefined as string | undefined })), ...(ext?.timed ?? []).map((x) => ({ ev: x.ev, time: formatTime(toHHMM(Math.round(x.start)), prefs) }))];
        const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
        const evLimit = Math.min(evs.length, isDesktop ? 2 : 1);
        const limit = (isDesktop ? 4 : 3) - evLimit;
        return (
          <div
            key={d}
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
              if (id) act((force) => app.tasks.update(id, kind === 'deadline' ? { deadline: d } : { scheduledDate: d }, { force }));
            }}
            className={cx('flex min-h-20 flex-col gap-0.5 border-r border-b border-line p-1 lg:min-h-28', !inMonth && 'bg-surface-2/50 text-subtle', dropDay === d && 'ring-2 ring-inset ring-accent')}
          >
            <button
              type="button"
              aria-label={`${formatLongDate(d, prefs)}${list.length ? `, ${list.length} item${list.length > 1 ? 's' : ''}` : ''} — open day view`}
              onClick={() => onPickDay(d)}
              className={cx('flex h-6 w-6 items-center justify-center self-start rounded-full text-[0.8rem] hover:bg-surface-3', d === today && 'bg-accent font-semibold text-accent-fg hover:bg-accent')}
            >
              {Number(d.slice(8))}
            </button>
            {evs.slice(0, evLimit).map(({ ev, time }) => (
              <EventChip key={ev.id} ev={ev} time={time} />
            ))}
            {list.slice(0, limit).map((e, i) => (
              <button
                key={`${e.task.id}-${e.kind}-${i}`}
                type="button"
                draggable={e.kind !== 'repeat'}
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(DRAG_MIME, e.task.id);
                  ev.dataTransfer.setData('application/x-focus-kind', e.kind);
                }}
                onClick={() => openTask(e.task.id)}
                title={`${e.kind === 'deadline' ? 'Deadline: ' : e.kind === 'repeat' ? 'Repeats: ' : ''}${e.task.title}`}
                className={cx(
                  'flex items-center gap-1 truncate rounded px-1 py-px text-left leading-tight',
                  e.kind === 'deadline' ? 'border border-dashed border-warn text-warn' : e.kind === 'repeat' ? 'border border-dotted border-line-strong bg-transparent text-muted italic' : 'bg-surface-2 hover:bg-surface-3',
                  e.kind === 'scheduled' && e.date < today && 'text-danger',
                )}
              >
                {e.kind === 'deadline' ? <CalendarClock size={10} className="shrink-0" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[e.task.priority] }} />}
                {e.kind === 'scheduled' && e.task.scheduledTime && <span className="shrink-0 text-muted">{formatTime(e.task.scheduledTime, prefs)}</span>}
                <span className="truncate max-sm:hidden">{e.task.title}</span>
              </button>
            ))}
            {list.length + evs.length > limit + evLimit && (
              <button type="button" onClick={() => onPickDay(d)} className="px-1 text-left text-subtle hover:text-fg">
                +{list.length + evs.length - Math.min(list.length, limit) - evLimit} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

function Agenda({ from, entries, external, today }: { from: ISODate; entries: Map<ISODate, Entry[]>; external: Map<ISODate, ExtDay>; today: ISODate }) {
  const prefs = useDatePrefs();
  const days = Array.from({ length: 30 }, (_, i) => addDays(from, i)).filter((d) => (entries.get(d) ?? []).some((e) => e.kind !== 'repeat') || !!external.get(d));
  if (!days.length) return <p className="py-8 text-center text-muted">Nothing scheduled in the next 30 days.</p>;
  return (
    <div>
      {days.map((d) => {
        const list = (entries.get(d) ?? []).filter((e) => e.kind !== 'repeat');
        const tasks = [...new Map(list.map((e) => [e.task.id, e.task])).values()].sort((a, b) => (a.scheduledTime ?? '99').localeCompare(b.scheduledTime ?? '99'));
        return (
          <GroupHeading key={d} title={<>{d === today ? 'Today · ' : ''}{formatLongDate(d, prefs)}</>} count={tasks.length}>
            {external.get(d) && (
              <ul className="mb-1 flex flex-col gap-1 text-[0.85rem]" aria-label="From your calendars">
                {[...external.get(d)!.allDay.map((ev) => ({ ev, time: 'All day' })), ...external.get(d)!.timed.map((x) => ({ ev: x.ev, time: formatTime(toHHMM(Math.round(x.start)), prefs) }))].map(({ ev, time }) => (
                  <li key={ev.id}>
                    <EventChip ev={ev} time={time} />
                  </li>
                ))}
              </ul>
            )}
            <TaskList tasks={tasks} tree={false} showProject hideDate draggable ariaLabel={`Agenda for ${formatLongDate(d, prefs)}`} />
          </GroupHeading>
        );
      })}
    </div>
  );
}
