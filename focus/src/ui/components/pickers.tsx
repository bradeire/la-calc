import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Armchair, CalendarDays, CalendarX, Check, Inbox, Plus, Sun, Sunrise } from 'lucide-react';
import { addDays, formatLongDate, startOfWeek, weekdayIndex, WEEKDAY_SHORT } from '@/core/dates';
import { resolveDate } from '@/core/nlp/parser';
import type { Priority } from '@/core/domain/types';
import { useApp, useAction, useDatePrefs, useQuery, useToday } from '../hooks';
import { Input, MenuItem, MenuSeparator, Popover, cx } from '../primitives';
import { PRIORITY_LABEL, PriorityFlag, ProjectIcon } from './meta';

/** Date picker: quick choices, typed natural language ("next fri", "3/12"), or a native calendar input. */
export function DatePopover({
  anchor,
  open,
  onClose,
  value,
  onChange,
  title = 'Schedule',
  allowTime,
  time,
  onTimeChange,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  value: string | null;
  onChange: (d: string | null) => void;
  title?: string;
  allowTime?: boolean;
  time?: string | null;
  onTimeChange?: (t: string | null) => void;
}) {
  const today = useToday();
  const prefs = useDatePrefs();
  const [text, setText] = useState('');
  const typed = useMemo(() => (text.trim() ? resolveDate(text, today, prefs) : null), [text, today, prefs]);
  const pick = (d: string | null) => {
    onChange(d);
    setText('');
    onClose();
  };
  const wd = weekdayIndex(today);
  const quick: { label: string; date: string | null; icon: ReactNode }[] = [
    { label: 'Today', date: today, icon: <Sun size={16} className="text-ok" /> },
    { label: 'Tomorrow', date: addDays(today, 1), icon: <Sunrise size={16} className="text-warn" /> },
    ...(wd < 5 ? [{ label: 'This weekend', date: addDays(today, 5 - wd), icon: <Armchair size={16} className="text-p3" /> }] : []),
    { label: 'Next week', date: addDays(startOfWeek(today, prefs.weekStartsOn), 7), icon: <CalendarDays size={16} className="text-accent" /> },
    { label: 'No date', date: null, icon: <CalendarX size={16} /> },
  ];
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={title} width={290}>
      <div className="p-2">
        <Input
          placeholder="Type a date, e.g. next fri, 3 Dec"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed) pick(typed.date);
          }}
          aria-label="Type a date"
        />
        {text.trim() && (
          <p className="px-1 pt-1.5 text-[0.82rem] text-muted" aria-live="polite">
            {typed ? <>Press Enter for <strong className="text-fg">{formatLongDate(typed.date, prefs)}</strong></> : 'Not recognised yet'}
          </p>
        )}
      </div>
      <div role="menu">
        {quick.map((q) => (
          <MenuItem key={q.label} icon={q.icon} onClick={() => pick(q.date)} active={q.date === value}>
            <span className="flex justify-between gap-2">
              {q.label}
              {q.date && <span className="text-[0.8rem] text-subtle">{`${WEEKDAY_SHORT[weekdayIndex(q.date)]} ${Number(q.date.slice(8))}`}</span>}
            </span>
          </MenuItem>
        ))}
      </div>
      <MenuSeparator />
      <div className="flex flex-col gap-2 p-2">
        <label className="flex items-center justify-between gap-2 text-[0.85rem] text-muted">
          Pick a date
          <input
            type="date"
            className="rounded-md border border-line bg-surface px-2 py-1 text-fg"
            value={value ?? ''}
            onChange={(e) => e.target.value && pick(e.target.value)}
          />
        </label>
        {allowTime && onTimeChange && value && (
          <label className="flex items-center justify-between gap-2 text-[0.85rem] text-muted">
            Time
            <span className="flex items-center gap-1">
              <input
                type="time"
                className="rounded-md border border-line bg-surface px-2 py-1 text-fg"
                value={time ?? ''}
                onChange={(e) => onTimeChange(e.target.value || null)}
              />
              {time && (
                <button type="button" className="text-[0.8rem] text-muted hover:text-fg" onClick={() => onTimeChange(null)}>
                  Clear
                </button>
              )}
            </span>
          </label>
        )}
      </div>
    </Popover>
  );
}

export function PriorityPopover({
  anchor,
  open,
  onClose,
  value,
  onChange,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  value: Priority;
  onChange: (p: Priority) => void;
}) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Priority" width={200}>
      <div role="menu" className="py-1">
        {([1, 2, 3, 4] as Priority[]).map((p) => (
          <MenuItem
            key={p}
            icon={<PriorityFlag p={p} />}
            active={p === value}
            onClick={() => {
              onChange(p);
              onClose();
            }}
            shortcut={`p${p}`}
          >
            {PRIORITY_LABEL[p]}
          </MenuItem>
        ))}
      </div>
    </Popover>
  );
}

/** Choose a project (and optionally a section). `null` project = Inbox. */
export function ProjectPopover({
  anchor,
  open,
  onClose,
  value,
  onChange,
  withSections = true,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  value: { projectId: string | null; sectionId?: string | null };
  onChange: (v: { projectId: string | null; sectionId: string | null }) => void;
  withSections?: boolean;
}) {
  const app = useApp();
  const [q, setQ] = useState('');
  const projects = useQuery(() => app.repos.projects.list(), []);
  const sections = useQuery(
    () => (withSections ? projects.flatMap((p) => app.repos.projects.listSections(p.id)) : []),
    [projects, withSections],
  );
  const depth = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const d = (id: string | null, n = 0): number => (id && byId.get(id) && n < 10 ? d(byId.get(id)!.parentId, n + 1) : n);
    return (pid: string) => d(byId.get(pid)?.parentId ?? null);
  }, [projects]);
  const ordered = useMemo(() => orderProjects(projects), [projects]);
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const pick = (projectId: string | null, sectionId: string | null = null) => {
    onChange({ projectId, sectionId });
    onClose();
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Move to project" width={300}>
      <div className="p-2">
        <Input placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
      </div>
      <div role="menu" className="max-h-80 overflow-y-auto pb-1">
        {match('inbox') && (
          <MenuItem icon={<Inbox size={16} />} onClick={() => pick(null)} active={value.projectId === null}>
            Inbox
          </MenuItem>
        )}
        {ordered.map((p) => (
          <div key={p.id}>
            {match(p.name) && (
              <MenuItem
                icon={<ProjectIcon icon={p.icon} color={p.color} />}
                onClick={() => pick(p.id)}
                active={value.projectId === p.id && !value.sectionId}
              >
                <span style={{ paddingLeft: depth(p.id) * 12 }}>{p.name}</span>
              </MenuItem>
            )}
            {sections
              .filter((s) => s.projectId === p.id && (match(s.name) || (q && match(p.name))))
              .map((s) => (
                <MenuItem key={s.id} onClick={() => pick(p.id, s.id)} active={value.sectionId === s.id}>
                  <span className="text-muted" style={{ paddingLeft: depth(p.id) * 12 + 22 }}>
                    / {s.name}
                  </span>
                </MenuItem>
              ))}
          </div>
        ))}
      </div>
    </Popover>
  );
}

export function orderProjects<T extends { id: string; parentId: string | null; sortOrder: number }>(projects: readonly T[]): T[] {
  const out: T[] = [];
  const ids = new Set(projects.map((p) => p.id));
  const walk = (parent: string | null, depth: number) => {
    if (depth > 20) return;
    for (const p of projects.filter((x) => (parent === null ? !x.parentId || !ids.has(x.parentId) : x.parentId === parent)).sort((a, b) => a.sortOrder - b.sortOrder)) {
      out.push(p);
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function LabelPopover({
  anchor,
  open,
  onClose,
  value,
  onChange,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const app = useApp();
  const act = useAction();
  const [q, setQ] = useState('');
  const labels = useQuery(() => app.repos.labels.list(), []);
  const shown = labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase().replace(/^@/, '')));
  const exact = labels.some((l) => l.name.toLowerCase() === q.trim().toLowerCase().replace(/^@/, ''));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const create = () => {
    const name = q.trim().replace(/^@/, '');
    const id = act(() => app.labels.ensure([name])[0]);
    if (id) {
      onChange([...value, id]);
      setQ('');
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label="Labels" width={260}>
      <div className="p-2">
        <Input
          placeholder="Search or create label"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim() && !exact) create();
          }}
          aria-label="Search or create label"
        />
      </div>
      <div role="menu" className="max-h-72 overflow-y-auto pb-1">
        {shown.map((l) => (
          <MenuItem key={l.id} onClick={() => toggle(l.id)} icon={<span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />}>
            <span className="flex items-center justify-between">
              {l.name}
              {value.includes(l.id) && <Check size={15} className="text-accent" />}
            </span>
          </MenuItem>
        ))}
        {q.trim() && !exact && (
          <MenuItem icon={<Plus size={15} />} onClick={create}>
            Create “{q.trim().replace(/^@/, '')}”
          </MenuItem>
        )}
        {!shown.length && !q && <p className="px-3 py-2 text-[0.85rem] text-muted">No labels yet — type to create one.</p>}
      </div>
    </Popover>
  );
}

/** Button that toggles a popover; keeps the anchor ref wiring in one place. */
export function usePopover() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return { ref, open, show: () => setOpen(true), hide: () => setOpen(false), toggle: () => setOpen((o) => !o) };
}

export function PillButton({
  children,
  onClick,
  active,
  innerRef,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  innerRef?: RefObject<HTMLButtonElement | null>;
  label?: string;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.85rem] transition-colors max-lg:h-9',
        active ? 'border-line-strong bg-surface-2 text-fg' : 'border-line text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
