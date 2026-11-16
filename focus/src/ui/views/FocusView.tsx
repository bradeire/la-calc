import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Coffee, Play, SkipForward, Square } from 'lucide-react';
import { formatDuration, formatRelativeDate } from '@/core/dates';
import type { Task } from '@/core/domain/types';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { go, navigate, openTask, useLocation } from '../router';
import { Button, EmptyState, IconButton } from '../primitives';
import { PRIORITY_LABEL, PriorityFlag, ProjectIcon } from '../components/meta';
import { formatClock } from '../components/TaskDetail';

/**
 * Distraction-free execution screen. Works through Today's tasks in priority
 * order (or a task opened explicitly), with a start/stop timer.
 */
export function FocusView() {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const loc = useLocation();
  const [skipped, setSkipped] = useState<string[]>([]);
  const queue = useQuery(
    () =>
      app.repos.tasks
        .listToday(today)
        .filter((t) => !t.parentId || true)
        .sort((a, b) => a.priority - b.priority || (a.scheduledTime ?? '99').localeCompare(b.scheduledTime ?? '99')),
    [today],
  );
  const explicit = useQuery(() => (loc.taskId ? app.repos.tasks.get(loc.taskId) : undefined), [loc.taskId]);
  const pending = queue.filter((t) => !skipped.includes(t.id));
  const current: Task | undefined = explicit && !explicit.completedAt && !explicit.deletedAt ? explicit : pending[0];
  const next = pending.filter((t) => t.id !== current?.id).slice(0, 3);
  const running = useQuery(() => app.repos.time.running(), []);
  const isRunning = !!current && running?.taskId === current.id;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);
  const elapsed = isRunning && running ? Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 1000)) : 0;
  const project = useQuery(() => (current?.projectId ? app.repos.projects.get(current.projectId) : undefined), [current?.projectId]);
  const subtasks = useQuery(() => (current ? app.repos.tasks.children(current.id) : []), [current?.id]);
  const spentMin = (current?.actualMinutes ?? 0) + Math.floor(elapsed / 60);
  const pct = useMemo(() => (current?.durationMinutes ? Math.min(100, (spentMin / current.durationMinutes) * 100) : null), [current, spentMin]);

  const moveOn = () => {
    if (loc.taskId) navigate('/focus', { replace: true });
  };

  return (
    <div className="pt-safe flex min-h-[100dvh] flex-col bg-bg">
      <header className="flex h-14 items-center gap-2 px-4">
        <IconButton label="Leave Focus mode" onClick={() => (window.history.length > 1 ? window.history.back() : go({ name: 'today' }))}>
          <ArrowLeft size={20} />
        </IconButton>
        <span className="text-[0.9rem] font-medium text-muted">Focus</span>
        <span className="ml-auto text-[0.82rem] text-subtle">{pending.length} left today</span>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 pb-10">
        {!current ? (
          <EmptyState
            icon={<Coffee size={26} />}
            title="Nothing left for today"
            body={skipped.length ? 'You skipped some tasks.' : 'Plan more from Inbox or Upcoming, or take a break.'}
            action={skipped.length ? <Button onClick={() => setSkipped([])}>Show skipped tasks</Button> : <Button onClick={() => go({ name: 'today' })}>Back to Today</Button>}
          />
        ) : (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-3 text-[0.85rem] text-muted">
              <span className="flex items-center gap-1.5">
                <PriorityFlag p={current.priority} /> {PRIORITY_LABEL[current.priority]}
              </span>
              {project && (
                <span className="flex items-center gap-1.5">
                  <ProjectIcon icon={project.icon} color={project.color} size={14} /> {project.name}
                </span>
              )}
              {current.deadline && <span className="text-warn">Deadline {formatRelativeDate(current.deadline, today, prefs)}</span>}
            </div>
            <h1 className="mt-3 text-[1.9rem] font-bold leading-tight tracking-tight">{current.title}</h1>
            {current.description && <p className="mt-3 whitespace-pre-wrap text-[1rem] text-muted">{current.description}</p>}
            {subtasks.length > 0 && (
              <ul className="mt-4 flex flex-col gap-1 text-[0.95rem]">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={!!s.completedAt}
                      aria-label={`Complete ${s.title}`}
                      onClick={() => act((force) => (s.completedAt ? app.tasks.reopen(s.id) : app.tasks.complete(s.id, { force })))}
                      className="flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] border-line-strong"
                    >
                      {s.completedAt && <Check size={10} />}
                    </button>
                    <span className={s.completedAt ? 'text-muted line-through' : ''}>{s.title}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-10 flex flex-col items-center gap-3">
              <div className="font-mono text-[3rem] font-light tabular-nums tracking-tight" aria-live="off" aria-label="Elapsed time">
                {formatClock(elapsed)}
              </div>
              <p className="text-[0.88rem] text-muted">
                {formatDuration(spentMin)} spent{current.durationMinutes ? ` of ${formatDuration(current.durationMinutes)} estimated` : ''}
              </p>
              {pct !== null && (
                <div className="h-1.5 w-56 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Time against estimate">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {isRunning ? (
                  <Button onClick={() => act(() => app.tasks.stopTimer())}>
                    <Square size={14} /> Pause timer
                  </Button>
                ) : (
                  <Button onClick={() => act(() => app.tasks.startTimer(current.id))}>
                    <Play size={14} /> Start timer
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => {
                    act((force) => app.tasks.complete(current.id, { force }));
                    moveOn();
                  }}
                >
                  <Check size={16} /> Complete
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (isRunning) act(() => app.tasks.stopTimer());
                    setSkipped((s) => [...s, current.id]);
                    moveOn();
                  }}
                >
                  <SkipForward size={15} /> Skip
                </Button>
              </div>
              <button type="button" className="mt-2 text-[0.82rem] text-subtle hover:text-fg" onClick={() => (go({ name: 'today' }), setTimeout(() => openTask(current.id), 0))}>
                Edit details
              </button>
            </div>

            {next.length > 0 && (
              <section className="mt-auto pt-10">
                <h2 className="text-[0.78rem] font-semibold uppercase tracking-wide text-subtle">Next up</h2>
                <ul className="mt-2 flex flex-col">
                  {next.map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => navigate(`/focus?task=${t.id}`, { replace: true })} className="flex w-full items-center gap-2 border-b border-line py-2 text-left text-[0.92rem] hover:text-accent">
                        <PriorityFlag p={t.priority} size={13} /> <span className="truncate">{t.title}</span>
                        {t.durationMinutes && <span className="ml-auto text-[0.8rem] text-subtle">{formatDuration(t.durationMinutes)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="mt-6 text-center text-[0.75rem] text-subtle">The timer records time while it runs; it doesn’t assume you were working. Correct entries in the task’s Time section.</p>
          </>
        )}
      </main>
    </div>
  );
}
