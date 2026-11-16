import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, CalendarDays, Flag, Folder, Inbox, Repeat, Tag, Timer, X } from 'lucide-react';
import { formatDuration, formatRelativeDate, formatTime } from '@/core/dates';
import type { Priority } from '@/core/domain/types';
import { parseQuickAdd, type ParsedToken, type TokenKind } from '@/core/nlp/parser';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useDatePrefs, useQuery, useSettings, useToday } from '../hooks';
import { openTask } from '../router';
import { Button, Dialog, Kbd, cx } from '../primitives';
import { DatePopover, LabelPopover, PillButton, PriorityPopover, ProjectPopover, usePopover } from './pickers';
import { PRIORITY_LABEL, PriorityFlag, ProjectIcon } from './meta';

const KIND_ICON: Record<TokenKind, typeof CalendarDays> = {
  date: CalendarDays, time: CalendarDays, start: CalendarDays, deadline: CalendarClock, duration: Timer,
  recurrence: Repeat, priority: Flag, project: Folder, label: Tag,
};
const KIND_NAME: Record<TokenKind, string> = {
  date: 'Date', time: 'Time', start: 'Starts', deadline: 'Deadline', duration: 'Estimate', recurrence: 'Repeats',
  priority: 'Priority', project: 'Project', label: 'Label',
};

interface Overrides {
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  deadline?: string | null;
  priority?: Priority;
  place?: { projectId: string | null; sectionId: string | null };
  labelIds?: string[];
}

export function QuickAdd() {
  const { open, defaults, initialText } = useUi((s) => s.quickAdd);
  const close = useUi((s) => s.closeQuickAdd);
  const pushToast = useUi((s) => s.pushToast);
  const app = useApp();
  const today = useToday();
  const prefs = useDatePrefs();
  useSettings();
  const [text, setText] = useState('');
  const [description, setDescription] = useState('');
  const [showDesc, setShowDesc] = useState(false);
  const [disabled, setDisabled] = useState<{ key: string; text: string }[]>([]);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [ov, setOv] = useState<Overrides>({});
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const projects = useQuery(() => app.repos.projects.list(), []);
  const labels = useQuery(() => app.repos.labels.list(), []);

  useEffect(() => {
    if (open) {
      setText(initialText ?? '');
      setDescription('');
      setShowDesc(false);
      setDisabled([]);
      setChoices({});
      setOv({});
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialText]);

  const parsed = useMemo(
    () =>
      parseQuickAdd(text, {
        prefs,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        labels: labels.map((l) => ({ id: l.id, name: l.name })),
        disabled: new Set(disabled.map((d) => d.key)),
        choices,
      }),
    [text, prefs, projects, labels, disabled, choices],
  );

  // Effective values = parsed, then defaults from the current view, then manual overrides.
  const scheduledDate = ov.scheduledDate !== undefined ? ov.scheduledDate : (parsed.scheduledDate ?? defaults.scheduledDate ?? null);
  const scheduledTime = ov.scheduledTime !== undefined ? ov.scheduledTime : (parsed.scheduledTime ?? (parsed.scheduledDate ? null : (defaults.scheduledTime ?? null)));
  const deadline = ov.deadline !== undefined ? ov.deadline : parsed.deadline;
  const priority: Priority = ov.priority ?? parsed.priority ?? 4;
  const placeProjectId = ov.place ? ov.place.projectId : parsed.project ? parsed.project.id : (defaults.projectId ?? null);
  const placeSectionId = ov.place ? ov.place.sectionId : parsed.project ? null : (defaults.sectionId ?? null);
  const newProjectName = !ov.place && parsed.project && !parsed.project.id ? parsed.project.name : null;
  const extraLabels = ov.labelIds ?? defaults.labelIds ?? [];
  const project = projects.find((p) => p.id === placeProjectId);
  const parentTask = useQuery(() => (defaults.parentId ? app.repos.tasks.get(defaults.parentId) : undefined), [defaults.parentId]);

  const datePop = usePopover();
  const deadlinePop = usePopover();
  const prioPop = usePopover();
  const projPop = usePopover();
  const labelPop = usePopover();

  // Keep the highlight mirror the same height/scroll as the textarea.
  useLayoutEffect(() => {
    const resize = () => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      // scrollHeight is 0 until the native dialog is shown; CSS min-height covers that frame.
      if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`;
      if (mirrorRef.current) mirrorRef.current.scrollTop = ta.scrollTop;
    };
    resize();
    const raf = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(raf);
  }, [text, open]);

  const disableToken = (t: ParsedToken) => setDisabled((d) => [...d, { key: t.key, text: t.text }]);

  const submit = (keepOpen: boolean) => {
    setError(null);
    try {
      const effective = {
        ...parsed,
        scheduledDate,
        scheduledTime: scheduledDate ? scheduledTime : null,
        deadline,
        priority,
        project: ov.place ? null : parsed.project,
        labels: [...parsed.labels, ...extraLabels.filter((id) => !parsed.labels.some((l) => l.id === id)).map((id) => ({ id, name: '', isNew: false }))],
      };
      const task = app.quickAdd.commit(
        effective,
        { ...defaults, projectId: ov.place ? ov.place.projectId : defaults.projectId, sectionId: ov.place ? ov.place.sectionId : defaults.sectionId, labelIds: [] },
        { description },
      );
      const where = task.projectId ? (app.repos.projects.get(task.projectId)?.name ?? 'project') : 'Inbox';
      pushToast({
        message: `Added “${task.title}” to ${where}`,
        tone: 'success',
        action: { label: 'Open', run: () => openTask(task.id) },
      });
      if (keepOpen) {
        setText('');
        setDescription('');
        setDisabled([]);
        setChoices({});
        setOv((o) => ({ place: o.place, labelIds: o.labelIds }));
        inputRef.current?.focus();
      } else close();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // Mirror with <mark> for each recognised token.
  const segments = useMemo(() => {
    const out: { text: string; kind?: TokenKind }[] = [];
    let i = 0;
    for (const t of parsed.tokens) {
      if (t.start > i) out.push({ text: text.slice(i, t.start) });
      out.push({ text: text.slice(t.start, t.end), kind: t.kind });
      i = t.end;
    }
    out.push({ text: text.slice(i) + '​' });
    return out;
  }, [parsed.tokens, text]);

  const tokenValue = (t: ParsedToken): string => {
    switch (t.kind) {
      case 'date': return parsed.scheduledDate ? formatRelativeDate(parsed.scheduledDate, today, prefs) : t.text;
      case 'time': return parsed.scheduledTime ? formatTime(parsed.scheduledTime, prefs) : t.text;
      case 'deadline': return parsed.deadline ? formatRelativeDate(parsed.deadline, today, prefs) : t.text;
      case 'start': return parsed.startDate ? formatRelativeDate(parsed.startDate, today, prefs) : t.text;
      case 'duration': return parsed.durationMinutes ? formatDuration(parsed.durationMinutes) : t.text;
      case 'recurrence': return parsed.recurrenceText ?? t.text;
      case 'priority': return `P${parsed.priority}`;
      case 'project': return parsed.project ? `${parsed.project.name}${parsed.project.isNew ? ' (new)' : ''}` : t.text;
      case 'label': {
        const name = t.text.replace(/^[@#]/, '').toLowerCase();
        const l = parsed.labels.find((x) => x.name.toLowerCase() === name);
        return l ? `${l.name}${l.isNew ? ' (new)' : ''}` : t.text;
      }
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Quick Add" position="top" size="lg" hideTitle>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        {parentTask && <p className="text-[0.82rem] text-muted">Subtask of “{parentTask.title}”</p>}
        <div className="relative text-[1.05rem] leading-[1.6]">
          <div
            ref={mirrorRef}
            aria-hidden
            className="qa-mirror pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-0.5 text-transparent"
          >
            {segments.map((s, i) => (s.kind ? <mark key={i} className={`k-${s.kind}`}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>))}
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            aria-label="Task name with optional date, #project, @label, p1–p4"
            placeholder="e.g. Phone dentist Friday 10am #home p2"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onScroll={(e) => mirrorRef.current && (mirrorRef.current.scrollTop = e.currentTarget.scrollTop)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e.ctrlKey || e.metaKey);
              }
            }}
            enterKeyHint="done"
            autoCapitalize="sentences"
            className="relative min-h-[1.7em] w-full resize-none bg-transparent px-0.5 font-medium text-fg caret-accent outline-none placeholder:font-normal placeholder:text-subtle"
          />
        </div>

        {showDesc ? (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            aria-label="Description"
            rows={2}
            className="w-full resize-y bg-transparent text-[0.92rem] text-fg outline-none placeholder:text-subtle"
          />
        ) : (
          <button type="button" className="self-start text-[0.85rem] text-subtle hover:text-muted" onClick={() => setShowDesc(true)}>
            + Description
          </button>
        )}

        {(parsed.tokens.length > 0 || disabled.length > 0) && (
          <div className="flex flex-wrap gap-1.5" aria-label="Recognised details">
            {parsed.tokens.map((t) => {
              const I = KIND_ICON[t.kind];
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => disableToken(t)}
                  title={`Tap to keep “${t.text}” as text instead`}
                  className="group inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[0.8rem] text-fg hover:bg-surface-3"
                >
                  <I size={13} className="text-muted" aria-hidden />
                  <span className="text-muted">{KIND_NAME[t.kind]}:</span> {tokenValue(t)}
                  <X size={12} className="text-subtle group-hover:text-fg" aria-label="Keep as text" />
                </button>
              );
            })}
            {disabled.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDisabled((x) => x.filter((y) => y.key !== d.key))}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-line-strong px-2 py-1 text-[0.8rem] text-muted"
                title="Recognise again"
              >
                “{d.text}” kept as text · undo
              </button>
            ))}
          </div>
        )}

        {parsed.ambiguities.map((a) => (
          <div key={a.key} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[0.85rem]" role="status">
            <span className="flex items-center gap-1.5 text-warn">
              <AlertTriangle size={14} aria-hidden /> {a.message}
            </span>
            {a.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={a.message}>
                {a.options.map((o, i) => (
                  <button
                    key={o}
                    type="button"
                    role="radio"
                    aria-checked={a.selected === i}
                    onClick={() => setChoices((c) => ({ ...c, [a.key]: i }))}
                    className={cx(
                      'rounded-md border px-2 py-1',
                      a.selected === i ? 'border-accent bg-surface text-fg' : 'border-line text-muted hover:text-fg',
                    )}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-1.5">
          <PillButton innerRef={datePop.ref} onClick={datePop.toggle} active={!!scheduledDate} label="Schedule">
            <CalendarDays size={14} />
            {scheduledDate ? `${formatRelativeDate(scheduledDate, today, prefs)}${scheduledTime ? ` ${formatTime(scheduledTime, prefs)}` : ''}` : 'Date'}
          </PillButton>
          <PillButton innerRef={deadlinePop.ref} onClick={deadlinePop.toggle} active={!!deadline} label="Deadline">
            <CalendarClock size={14} />
            {deadline ? `Due ${formatRelativeDate(deadline, today, prefs)}` : 'Deadline'}
          </PillButton>
          <PillButton innerRef={prioPop.ref} onClick={prioPop.toggle} active={priority < 4} label="Priority">
            <PriorityFlag p={priority} size={14} />
            {priority < 4 ? `P${priority}` : 'Priority'}
          </PillButton>
          <PillButton innerRef={labelPop.ref} onClick={labelPop.toggle} active={extraLabels.length > 0} label="Labels">
            <Tag size={14} />
            {extraLabels.length ? `${extraLabels.length} label${extraLabels.length > 1 ? 's' : ''}` : 'Labels'}
          </PillButton>
        </div>

        {error && (
          <p role="alert" className="text-[0.85rem] text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <PillButton innerRef={projPop.ref} onClick={projPop.toggle} label="Project">
            {newProjectName ? (
              <>
                <Folder size={14} /> {newProjectName} <span className="text-subtle">(new)</span>
              </>
            ) : project ? (
              <>
                <ProjectIcon icon={project.icon} color={project.color} size={14} /> {project.name}
              </>
            ) : (
              <>
                <Inbox size={14} /> Inbox
              </>
            )}
          </PillButton>
          <div className="flex items-center gap-2">
            <span className="hidden text-[0.75rem] text-subtle lg:inline">
              <Kbd>Enter</Kbd> add · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> add another
            </span>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!parsed.title.trim()}>
              Add task
            </Button>
          </div>
        </div>
      </form>

      <DatePopover
        anchor={datePop.ref}
        open={datePop.open}
        onClose={datePop.hide}
        value={scheduledDate}
        onChange={(d) => setOv((o) => ({ ...o, scheduledDate: d }))}
        allowTime
        time={scheduledTime}
        onTimeChange={(t) => setOv((o) => ({ ...o, scheduledTime: t }))}
      />
      <DatePopover
        anchor={deadlinePop.ref}
        open={deadlinePop.open}
        onClose={deadlinePop.hide}
        value={deadline}
        onChange={(d) => setOv((o) => ({ ...o, deadline: d }))}
        title="Deadline"
      />
      <PriorityPopover anchor={prioPop.ref} open={prioPop.open} onClose={prioPop.hide} value={priority} onChange={(p) => setOv((o) => ({ ...o, priority: p }))} />
      <ProjectPopover
        anchor={projPop.ref}
        open={projPop.open}
        onClose={projPop.hide}
        value={{ projectId: placeProjectId, sectionId: placeSectionId }}
        onChange={(v) => setOv((o) => ({ ...o, place: v }))}
      />
      <LabelPopover anchor={labelPop.ref} open={labelPop.open} onClose={labelPop.hide} value={extraLabels} onChange={(ids) => setOv((o) => ({ ...o, labelIds: ids }))} />
      <span className="sr-only" aria-live="polite">
        {parsed.tokens.length ? `Recognised ${parsed.tokens.map((t) => KIND_NAME[t.kind]).join(', ')}` : ''}
        {priority < 4 ? ` ${PRIORITY_LABEL[priority]}` : ''}
      </span>
    </Dialog>
  );
}
