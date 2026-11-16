import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpLeft, Bell, CalendarClock, CalendarDays, CalendarRange, ChevronDown, CircleDot, Copy, Download, Ellipsis, Flag, Folder,
  History, Inbox, MessageSquare, Paperclip, Pin, Play, Plus, Repeat, Square, Tag, Timer, Trash2, X,
} from 'lucide-react';
import { formatDuration, formatLongDate, formatRelativeDate, formatTime, todayISO } from '@/core/dates';
import { isOpenStatus, STATUS_LABELS, TASK_STATUSES, type Task, type TaskStatus } from '@/core/domain/types';
import { parseQuickAdd } from '@/core/nlp/parser';
import { describeRule, firstOccurrenceOnOrAfter } from '@/core/recurrence/engine';
import { useUi } from '@/state/ui-store';
import { errorMessage, useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { closeTask, go, navigate, openTask } from '../router';
import { Button, IconButton, Input, MenuItem, MenuSeparator, Popover, Select, Switch, Textarea, cx } from '../primitives';
import { DatePopover, LabelPopover, PriorityPopover, ProjectPopover, usePopover } from './pickers';
import { LabelChip, PRIORITY_LABEL, PriorityFlag, ProjectIcon } from './meta';
import { TaskList } from './TaskList';
import { DependenciesSection } from './DependenciesSection';
import { TaskAiMenu } from './AiFeatures';

export function TaskDetail({ taskId, variant }: { taskId: string; variant: 'panel' | 'sheet' }) {
  const app = useApp();
  const task = useQuery(() => app.repos.tasks.get(taskId), [taskId]);
  if (!task || task.deletedAt) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted">
        <p>{task?.deletedAt ? 'This task is in Trash.' : 'This task no longer exists.'}</p>
        <div className="flex gap-2">
          {task?.deletedAt && (
            <Button onClick={() => app.tasks.restore(task.id)} variant="primary">
              Restore
            </Button>
          )}
          <Button onClick={closeTask}>Close</Button>
        </div>
      </div>
    );
  }
  return <TaskEditor key={task.id} task={task} variant={variant} />;
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 py-1">
      <div className="flex w-28 shrink-0 items-center gap-2 text-[0.85rem] text-muted">
        <span className="text-subtle" aria-hidden>
          {icon}
        </span>
        {label}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function ValueButton({ children, onClick, innerRef, muted, label }: { children: ReactNode; onClick: () => void; innerRef?: React.RefObject<HTMLButtonElement | null>; muted?: boolean; label: string }) {
  return (
    <button
      ref={innerRef}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx('inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-left text-[0.9rem] hover:bg-surface-2', muted ? 'text-subtle' : 'text-fg')}
    >
      {children}
    </button>
  );
}

export function Section({ icon, title, children, count, defaultOpen = true, action }: { icon: ReactNode; title: string; children: ReactNode; count?: number; defaultOpen?: boolean; action?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  // Expand when something is added (e.g. a file uploaded while collapsed) so the user sees it.
  const prevCount = useRef(count ?? 0);
  useEffect(() => {
    if ((count ?? 0) > prevCount.current) setOpen(true);
    prevCount.current = count ?? 0;
  }, [count]);
  return (
    <section className="border-t border-line py-3">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-2 text-[0.88rem] font-semibold">
          <span className="text-muted">{icon}</span>
          {title}
          {count ? <span className="font-normal text-subtle">{count}</span> : null}
          <ChevronDown size={14} className={cx('text-subtle transition-transform', !open && '-rotate-90')} />
        </button>
        {action}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

function TaskEditor({ task, variant }: { task: Task; variant: 'panel' | 'sheet' }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDesc(task.description), [task.description]);
  useEffect(() => {
    const t = titleRef.current;
    if (t) {
      t.style.height = 'auto';
      t.style.height = `${t.scrollHeight}px`;
    }
  }, [title]);

  const project = useQuery(() => (task.projectId ? app.repos.projects.get(task.projectId) : undefined), [task.projectId]);
  const section = useQuery(() => (task.sectionId ? app.repos.projects.getSection(task.sectionId) : undefined), [task.sectionId]);
  const ancestors = useQuery(() => app.repos.tasks.ancestors(task.id).reverse(), [task.id]);
  const labels = useQuery(() => app.repos.labels.list(), []);
  const subtasks = useQuery(() => app.repos.tasks.getMany(app.repos.tasks.descendantIds(task.id)), [task.id]);
  const open = isOpenStatus(task.status);

  const update = (patch: Parameters<typeof app.tasks.update>[1]) => act((force) => app.tasks.update(task.id, patch, { force }));
  const saveTitle = () => {
    const t = title.trim();
    if (!t) return setTitle(task.title);
    if (t !== task.title) update({ title: t });
  };

  const datePop = usePopover();
  const startPop = usePopover();
  const deadlinePop = usePopover();
  const prioPop = usePopover();
  const projPop = usePopover();
  const labelPop = usePopover();
  const morePop = usePopover();

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className={cx('flex items-center gap-1 border-b border-line px-3', variant === 'sheet' ? 'pt-safe h-auto min-h-14' : 'h-12')}>
        <nav aria-label="Location" className="flex min-w-0 flex-1 items-center gap-1 text-[0.85rem] text-muted">
          <button type="button" className="flex min-w-0 items-center gap-1.5 truncate rounded px-1.5 py-1 hover:bg-surface-2" onClick={() => (project ? go({ name: 'project', id: project.id }) : go({ name: 'inbox' }))}>
            {project ? <ProjectIcon icon={project.icon} color={project.color} size={14} /> : <Inbox size={14} />}
            <span className="truncate">{project?.name ?? 'Inbox'}</span>
            {section && <span className="truncate text-subtle">/ {section.name}</span>}
          </button>
          {ancestors.map((a) => (
            <button key={a.id} type="button" className="truncate rounded px-1 py-1 hover:bg-surface-2" onClick={() => openTask(a.id)}>
              › {a.title}
            </button>
          ))}
        </nav>
        <TaskAiMenu task={task} />
        <IconButton label="Open in Focus mode" onClick={() => navigate(`/focus?task=${task.id}`)}>
          <Play size={16} />
        </IconButton>
        <IconButton label="More actions" ref={morePop.ref} onClick={morePop.toggle}>
          <Ellipsis size={18} />
        </IconButton>
        <IconButton label="Close details" onClick={closeTask}>
          <X size={18} />
        </IconButton>
      </header>

      <div data-scroll-root className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 scrollbar-thin">
        <div className="flex items-start gap-3 pt-4">
          <button
            type="button"
            role="checkbox"
            aria-checked={!open}
            aria-label={open ? 'Complete task' : 'Reopen task'}
            onClick={() => act((force) => (open ? app.tasks.complete(task.id, { force }) : app.tasks.reopen(task.id)))}
            className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2"
            style={{ borderColor: `var(--p${task.priority})`, background: open ? 'transparent' : `var(--p${task.priority})` }}
          />
          <textarea
            ref={titleRef}
            value={title}
            rows={1}
            aria-label="Task title"
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                setTitle(task.title);
                e.currentTarget.blur();
              }
            }}
            className={cx('w-full resize-none bg-transparent text-[1.2rem] font-semibold leading-snug outline-none', !open && 'text-muted line-through')}
          />
        </div>
        <Textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc !== task.description && update({ description: desc })}
          placeholder="Add a description…"
          aria-label="Description"
          rows={Math.min(10, Math.max(2, desc.split('\n').length))}
          className="mt-2 border-transparent bg-transparent px-0 text-[0.93rem] hover:border-line focus:px-3"
        />

        <div className="mt-2 flex flex-col">
          <Row icon={<CircleDot size={15} />} label="Status">
            <Select
              aria-label="Status"
              value={task.status}
              onChange={(e) => act(() => app.tasks.setStatus(task.id, e.target.value as TaskStatus))}
              className="h-8 border-transparent bg-transparent px-1 hover:border-line"
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Row>
          <Row icon={<Folder size={15} />} label="Project">
            <ValueButton innerRef={projPop.ref} onClick={projPop.toggle} label="Change project">
              {project ? <ProjectIcon icon={project.icon} color={project.color} size={14} /> : <Inbox size={14} />}
              {project?.name ?? 'Inbox'}
              {section && <span className="text-muted">/ {section.name}</span>}
            </ValueButton>
          </Row>
          <Row icon={<Flag size={15} />} label="Priority">
            <ValueButton innerRef={prioPop.ref} onClick={prioPop.toggle} label="Change priority">
              <PriorityFlag p={task.priority} /> {PRIORITY_LABEL[task.priority]}
            </ValueButton>
          </Row>
          <Row icon={<CalendarDays size={15} />} label="Scheduled">
            <ValueButton innerRef={datePop.ref} onClick={datePop.toggle} muted={!task.scheduledDate} label="Change scheduled date">
              {task.scheduledDate
                ? `${formatRelativeDate(task.scheduledDate, today, prefs)}${task.scheduledTime ? `, ${formatTime(task.scheduledTime, prefs)}` : ''}`
                : 'Not scheduled'}
            </ValueButton>
            {task.scheduledDate && <span className="text-[0.8rem] text-subtle">{formatLongDate(task.scheduledDate, prefs)}</span>}
          </Row>
          <Row icon={<CalendarClock size={15} />} label="Deadline">
            <ValueButton innerRef={deadlinePop.ref} onClick={deadlinePop.toggle} muted={!task.deadline} label="Change deadline">
              {task.deadline ? formatRelativeDate(task.deadline, today, prefs) : 'No deadline'}
            </ValueButton>
            {task.deadline && task.scheduledDate && task.scheduledDate > task.deadline && (
              <span className="text-[0.8rem] text-danger">Scheduled after the deadline</span>
            )}
          </Row>
          <Row icon={<CalendarRange size={15} />} label="Starts">
            <ValueButton innerRef={startPop.ref} onClick={startPop.toggle} muted={!task.startDate} label="Change start date">
              {task.startDate ? formatRelativeDate(task.startDate, today, prefs) : 'Any time'}
            </ValueButton>
          </Row>
          <Row icon={<Timer size={15} />} label="Estimate">
            <DurationInput value={task.durationMinutes} onChange={(m) => update({ durationMinutes: m })} />
          </Row>
          <Row icon={<Repeat size={15} />} label="Repeat">
            <RecurrenceEditor task={task} />
          </Row>
          <Row icon={<Tag size={15} />} label="Labels">
            {task.labelIds
              .map((id) => labels.find((l) => l.id === id))
              .filter((l) => !!l)
              .map((l) => (
                <LabelChip key={l!.id} label={l!} onRemove={() => update({ labelIds: task.labelIds.filter((x) => x !== l!.id) })} />
              ))}
            <ValueButton innerRef={labelPop.ref} onClick={labelPop.toggle} muted label="Add labels">
              <Plus size={14} /> {task.labelIds.length ? '' : 'Add label'}
            </ValueButton>
          </Row>
          <Row icon={<Pin size={15} />} label="On Today">
            <Switch checked={task.pinnedToday} onChange={(v) => update({ pinnedToday: v })} label="Show on Today even without a date" />
            <span className="text-[0.8rem] text-subtle">Show on Today without a date</span>
          </Row>
        </div>

        <Section icon={<CircleDot size={15} />} title="Subtasks" count={subtasks.length} action={
          <Button size="sm" variant="ghost" onClick={() => openQuickAdd({ parentId: task.id })}>
            <Plus size={14} /> Add
          </Button>
        }>
          {subtasks.length ? <TaskList tasks={subtasks} ariaLabel="Subtasks" reorderable /> : null}
          <InlineSubtaskAdd parent={task} />
        </Section>

        <DependenciesSection task={task} />
        <TimeSection task={task} />
        <RemindersSection task={task} />
        <CommentsSection task={task} />
        <AttachmentsSection target={{ taskId: task.id }} />
        <ActivitySection task={task} />

        <p className="mt-4 text-[0.75rem] text-subtle">
          Created {new Date(task.createdAt).toLocaleString('en-GB')}
          {task.completedAt && ` · Completed ${new Date(task.completedAt).toLocaleString('en-GB')}`}
        </p>
      </div>

      <DatePopover
        anchor={datePop.ref}
        open={datePop.open}
        onClose={datePop.hide}
        value={task.scheduledDate}
        onChange={(d) => update({ scheduledDate: d })}
        allowTime
        time={task.scheduledTime}
        onTimeChange={(t) => update({ scheduledTime: t })}
      />
      <DatePopover anchor={deadlinePop.ref} open={deadlinePop.open} onClose={deadlinePop.hide} value={task.deadline} onChange={(d) => update({ deadline: d })} title="Deadline" />
      <DatePopover anchor={startPop.ref} open={startPop.open} onClose={startPop.hide} value={task.startDate} onChange={(d) => update({ startDate: d })} title="Start date" />
      <PriorityPopover anchor={prioPop.ref} open={prioPop.open} onClose={prioPop.hide} value={task.priority} onChange={(p) => update({ priority: p })} />
      <ProjectPopover
        anchor={projPop.ref}
        open={projPop.open}
        onClose={projPop.hide}
        value={{ projectId: task.projectId, sectionId: task.sectionId }}
        onChange={(v) => act(() => app.tasks.move([task.id], v))}
      />
      <LabelPopover anchor={labelPop.ref} open={labelPop.open} onClose={labelPop.hide} value={task.labelIds} onChange={(ids) => update({ labelIds: ids })} />
      <Popover anchor={morePop.ref} open={morePop.open} onClose={morePop.hide} label="Task actions" width={230}>
        <div role="menu" className="py-1">
          <MenuItem icon={<Copy size={15} />} onClick={() => { morePop.hide(); const d = act(() => app.tasks.duplicate(task.id)); if (d) openTask(d.id); }}>
            Duplicate
          </MenuItem>
          {task.parentId && (
            <MenuItem icon={<ArrowUpLeft size={15} />} onClick={() => (morePop.hide(), act(() => app.tasks.promote(task.id)))}>
              Make independent task
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { morePop.hide(); closeTask(); act(() => app.tasks.remove([task.id])); }}>
            Delete task
          </MenuItem>
        </div>
      </Popover>
    </div>
  );
}

function DurationInput({ value, onChange }: { value: number | null; onChange: (m: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  const presets = [15, 30, 60, 120];
  return (
    <>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={43200}
        aria-label="Estimated minutes"
        placeholder="mins"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = text ? Math.round(Number(text)) : null;
          if (n !== value) onChange(n && n > 0 ? n : null);
        }}
        className="h-8 !w-20"
      />
      {presets.map((p) => (
        <button key={p} type="button" onClick={() => onChange(p)} className={cx('rounded-md px-1.5 py-0.5 text-[0.8rem] hover:bg-surface-2', value === p ? 'text-accent font-medium' : 'text-muted')}>
          {formatDuration(p)}
        </button>
      ))}
    </>
  );
}

function RecurrenceEditor({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [basis, setBasis] = useState<'scheduled' | 'completion'>(task.recurrence?.basis ?? 'scheduled');
  const parsed = useMemo(() => {
    const t = text.trim();
    if (!t) return null;
    const r = parseQuickAdd(/^(every|daily|weekly|monthly|yearly|fortnightly|annually|weekdays)/i.test(t) ? t : `every ${t}`);
    return r.recurrence;
  }, [text]);
  const save = () => {
    if (!parsed) return;
    const rule = { ...parsed, basis };
    const from = task.scheduledDate ?? todayISO();
    const first = firstOccurrenceOnOrAfter(rule, from) ?? from;
    act((force) => app.tasks.update(task.id, { recurrence: { ...rule, anchor: first }, recurrenceText: describeRule(rule), scheduledDate: first }, { force }));
    setEditing(false);
    setText('');
  };
  if (!editing) {
    return task.recurrence ? (
      <>
        <button type="button" onClick={() => setEditing(true)} className="rounded-md px-2 py-1 text-[0.9rem] hover:bg-surface-2">
          {describeRule(task.recurrence)}
        </button>
        <button type="button" onClick={() => act(() => app.tasks.update(task.id, { recurrence: null }))} className="text-[0.8rem] text-muted hover:text-danger">
          Stop repeating
        </button>
      </>
    ) : (
      <button type="button" onClick={() => setEditing(true)} className="rounded-md px-2 py-1 text-[0.9rem] text-subtle hover:bg-surface-2">
        Doesn’t repeat
      </button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Input
        autoFocus
        value={text}
        placeholder="e.g. every weekday, every 2 weeks, first monday of each month"
        aria-label="Repeat rule"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="h-8"
      />
      <div className="flex flex-wrap items-center gap-2 text-[0.82rem]">
        <span className={parsed ? 'text-ok' : 'text-subtle'}>{parsed ? describeRule({ ...parsed, basis }) : text ? 'Not recognised' : 'Type a pattern'}</span>
        <Select aria-label="Repeat basis" value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)} className="h-7 text-[0.8rem]">
          <option value="scheduled">from scheduled date</option>
          <option value="completion">from completion</option>
        </Select>
        <Button size="sm" variant="primary" disabled={!parsed} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function InlineSubtaskAdd({ parent }: { parent: Task }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const projects = useQuery(() => app.repos.projects.list(), []);
  const labels = useQuery(() => app.repos.labels.list(), []);
  const add = () => {
    if (!text.trim()) return;
    try {
      const parsed = parseQuickAdd(text, { projects, labels });
      // A #project in a subtask would detach it; keep subtasks under their parent.
      app.quickAdd.commit({ ...parsed, project: null }, { parentId: parent.id });
      setText('');
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <Plus size={15} className="ml-1 text-subtle" aria-hidden />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a subtask (dates and p1–p4 work here too)"
          aria-label="New subtask"
          className="h-9 flex-1 bg-transparent text-[0.92rem] outline-none placeholder:text-subtle"
        />
      </div>
      {error && <p className="text-[0.8rem] text-danger" role="alert">{error}</p>}
    </div>
  );
}

function useElapsed(startIso: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startIso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startIso]);
  return startIso ? Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000)) : 0;
}

export function formatClock(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

function TimeSection({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const running = useQuery(() => app.repos.time.running(), []);
  const entries = useQuery(() => app.repos.time.listForTask(task.id), [task.id]);
  const isMine = running?.taskId === task.id;
  const elapsed = useElapsed(isMine ? running?.startedAt : undefined);
  const [manual, setManual] = useState('');
  return (
    <Section icon={<Timer size={15} />} title="Time" defaultOpen={entries.length > 0 || isMine}>
      <div className="flex flex-wrap items-center gap-3 text-[0.88rem]">
        <span>
          <span className="text-muted">Spent </span>
          <strong>{formatDuration(task.actualMinutes + Math.floor(elapsed / 60))}</strong>
          {task.durationMinutes ? <span className="text-muted"> of {formatDuration(task.durationMinutes)} estimated</span> : null}
        </span>
        {isMine ? (
          <Button size="sm" variant="primary" onClick={() => act(() => app.tasks.stopTimer())}>
            <Square size={12} /> Stop {formatClock(elapsed)}
          </Button>
        ) : (
          <Button size="sm" onClick={() => act(() => app.tasks.startTimer(task.id))}>
            <Play size={12} /> Start timer
          </Button>
        )}
        <span className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={1440}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="mins"
            aria-label="Add minutes manually"
            className="h-7 w-20 text-[0.85rem]"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!manual}
            onClick={() => {
              if (act(() => app.tasks.addManualTime(task.id, Math.round(Number(manual))), { success: 'Time added' }) !== undefined) setManual('');
            }}
          >
            Log
          </Button>
        </span>
      </div>
      {entries.length > 0 && (
        <ul className="mt-2 flex flex-col text-[0.84rem]">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
              <span className="text-muted">
                {new Date(e.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {e.source === 'manual' ? 'manual' : 'timer'}
              </span>
              <span className="flex items-center gap-2">
                {e.minutes !== null ? formatDuration(e.minutes) : 'running'}
                {e.endedAt && (
                  <IconButton size="sm" label="Delete time entry" onClick={() => act(() => app.tasks.deleteTimeEntry(e.id))}>
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const OFFSETS = [
  { m: 0, label: 'At the time' },
  { m: 10, label: '10 minutes before' },
  { m: 30, label: '30 minutes before' },
  { m: 60, label: '1 hour before' },
  { m: 180, label: '3 hours before' },
  { m: 1440, label: '1 day before' },
  { m: 2880, label: '2 days before' },
];

function RemindersSection({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const reminders = useQuery(() => app.repos.reminders.listForTask(task.id), [task.id]);
  const [abs, setAbs] = useState('');
  const canRelative = !!(task.scheduledDate || task.deadline);
  return (
    <Section icon={<Bell size={15} />} title="Reminders" count={reminders.length} defaultOpen={reminders.length > 0}>
      <ul className="flex flex-col text-[0.88rem]">
        {reminders.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-1">
            <span>
              {r.kind === 'relative'
                ? `${OFFSETS.find((o) => o.m === r.offsetMinutes)?.label ?? `${r.offsetMinutes} minutes before`} ${task.scheduledDate ? 'scheduled time' : 'deadline'}`
                : new Date(r.remindAt!).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            <IconButton size="sm" label="Remove reminder" onClick={() => act(() => app.content.removeReminder(r.id))}>
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Select
          aria-label="Add relative reminder"
          value=""
          disabled={!canRelative}
          onChange={(e) => e.target.value && act(() => app.content.addReminder(task.id, { kind: 'relative', offsetMinutes: Number(e.target.value) }))}
          className="h-8 text-[0.85rem]"
        >
          <option value="">{canRelative ? 'Before the task…' : 'Schedule the task for relative reminders'}</option>
          {OFFSETS.map((o) => (
            <option key={o.m} value={o.m}>
              {o.label}
            </option>
          ))}
        </Select>
        <span className="flex items-center gap-1">
          <input
            type="datetime-local"
            aria-label="Reminder date and time"
            value={abs}
            onChange={(e) => setAbs(e.target.value)}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[0.85rem]"
          />
          <Button
            size="sm"
            disabled={!abs}
            onClick={() => {
              if (act(() => app.content.addReminder(task.id, { kind: 'absolute', remindAt: new Date(abs).toISOString() })) !== undefined) setAbs('');
            }}
          >
            Add
          </Button>
        </span>
      </div>
      <p className="mt-2 text-[0.78rem] text-subtle">
        Reminders appear while Focus is open (or running in the background on desktop). Turn on system notifications in Settings. Phones need the Android app for reminders while Focus is closed.
      </p>
    </Section>
  );
}

function CommentsSection({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const comments = useQuery(() => app.repos.comments.listForTask(task.id), [task.id]);
  const [text, setText] = useState('');
  const add = () => {
    if (act(() => app.content.addComment(task.id, text)) !== undefined) setText('');
  };
  return (
    <Section icon={<MessageSquare size={15} />} title="Comments" count={comments.length}>
      <ul className="flex flex-col gap-2">
        {comments.map((c) => (
          <li key={c.id} className="group rounded-lg bg-surface-2 px-3 py-2 text-[0.9rem]">
            <div className="flex items-start justify-between gap-2">
              <p className="whitespace-pre-wrap break-words">{c.body}</p>
              <IconButton size="sm" label="Delete comment" className="opacity-60 group-hover:opacity-100" onClick={() => act(() => app.content.removeComment(c.id))}>
                <Trash2 size={13} />
              </IconButton>
            </div>
            <p className="mt-1 text-[0.75rem] text-subtle">{new Date(c.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-col gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a comment"
          aria-label="New comment"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add();
          }}
        />
        <Button size="sm" variant="primary" className="self-end" disabled={!text.trim()} onClick={add}>
          Comment
        </Button>
      </div>
    </Section>
  );
}

/** Attachments for a task or a project. Files are stored on this device only. */
export function AttachmentsSection({ target }: { target: { taskId: string } | { projectId: string } }) {
  const app = useApp();
  const act = useAction();
  const pushToast = useUi((s) => s.pushToast);
  const key = 'taskId' in target ? target.taskId : target.projectId;
  const items = useQuery(
    () => ('taskId' in target ? app.repos.attachments.listForTask(target.taskId) : app.repos.attachments.listForProject(target.projectId)),
    [key],
  );
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      try {
        await app.content.addAttachment(target, f, f.name);
      } catch (err) {
        pushToast({ message: errorMessage(err), tone: 'error' });
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  const download = async (id: string) => {
    try {
      const { blob, fileName } = await app.content.getAttachmentBlob(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <Section
      icon={<Paperclip size={15} />}
      title="Attachments"
      count={items.length}
      defaultOpen={items.length > 0}
      action={
        <>
          {/* Kept outside the collapsible body so "Add file" works while the section is collapsed. */}
          <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} aria-label="Choose files to attach" />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
            <Plus size={14} /> {busy ? 'Adding…' : 'Add file'}
          </Button>
        </>
      }
    >
      {items.length === 0 && <p className="text-[0.85rem] text-subtle">Files are stored on this device only.</p>}
      <ul className="flex flex-col">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2 py-1 text-[0.88rem]">
            <span className="min-w-0 truncate">
              {a.fileName} <span className="text-subtle">· {(a.sizeBytes / 1024).toFixed(a.sizeBytes < 10240 ? 1 : 0)} KB</span>
            </span>
            <span className="flex shrink-0">
              <IconButton size="sm" label={`Download ${a.fileName}`} onClick={() => void download(a.id)}>
                <Download size={14} />
              </IconButton>
              <IconButton size="sm" label={`Remove ${a.fileName}`} onClick={() => act(() => app.content.removeAttachment(a.id))}>
                <Trash2 size={14} />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const ACTION_TEXT: Record<string, string> = {
  created: 'Created', completed: 'Completed', reopened: 'Reopened', deleted: 'Deleted', restored: 'Restored',
  'comment.added': 'Comment added', 'dependency.added': 'Now waiting on another task', 'dependency.removed': 'Dependency removed', 'attachment.added': 'Attachment added', 'timer.started': 'Timer started', 'timer.stopped': 'Timer stopped',
};
const FIELD_TEXT: Record<string, string> = {
  title: 'title', description: 'description', projectId: 'project', sectionId: 'section', parentId: 'parent', priority: 'priority',
  status: 'status', startDate: 'start date', scheduledDate: 'scheduled date', scheduledTime: 'time', deadline: 'deadline',
  durationMinutes: 'estimate', pinnedToday: 'Today pin', labelIds: 'labels', recurrence: 'repeat rule',
};

function ActivitySection({ task }: { task: Task }) {
  const app = useApp();
  const entries = useQuery(() => app.repos.activity.listFor(task.id, 50), [task.id]);
  return (
    <Section icon={<History size={15} />} title="Activity" count={entries.length} defaultOpen={false}>
      <ol className="flex flex-col gap-1 text-[0.82rem]">
        {entries.map((e) => (
          <li key={e.id} className="flex justify-between gap-3">
            <span>
              {e.action === 'updated'
                ? `Changed ${Object.keys(e.payload).map((k) => FIELD_TEXT[k] ?? k).join(', ')}`
                : (ACTION_TEXT[e.action] ?? e.action)}
              {e.action === 'timer.stopped' && typeof e.payload.minutes === 'number' ? ` (${formatDuration(e.payload.minutes)})` : ''}
            </span>
            <time className="shrink-0 text-subtle" dateTime={e.createdAt}>
              {new Date(e.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
            </time>
          </li>
        ))}
      </ol>
    </Section>
  );
}
