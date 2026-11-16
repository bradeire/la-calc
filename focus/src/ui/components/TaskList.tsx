import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUpLeft, CalendarDays, CalendarRange, Check, Clock, Lock, ChevronRight, CircleDot, Copy, Ellipsis, FolderInput, Hourglass, ListPlus, MessageSquare,
  Paperclip, PencilLine, Trash2,
} from 'lucide-react';
import { isOpenStatus, STATUS_LABELS, TASK_STATUSES, type Label, type Priority, type Project, type Task, type TaskStatus } from '@/core/domain/types';
import { buildTree, flattenTree, type TaskNode } from '@/core/tree';
import { formatRelativeDate, formatTime, type DatePrefs } from '@/core/dates';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { openTask } from '../router';
import { MenuItem, MenuSeparator, Popover, cx } from '../primitives';
import { DatePopover, PriorityPopover, ProjectPopover, usePopover } from './pickers';
import { DeadlineChip, DurationChip, LabelChip, PRIORITY_COLOR, PriorityFlag, ProgressRing, ProjectIcon, ScheduledChip } from './meta';

export const DRAG_MIME = 'application/x-focus-task';

interface Ctx {
  labels: Map<string, Label>;
  projects: Map<string, Project>;
  progress: Map<string, { done: number; total: number }>;
  comments: Map<string, number>;
  attachments: Set<string>;
  blocked: Set<string>;
  today: string;
  prefs: DatePrefs;
  showProject: boolean;
  reorderable: boolean;
  draggable: boolean;
  selection: Set<string>;
}

export interface TaskListProps {
  tasks: readonly Task[];
  /** Nest subtasks under parents present in the list. */
  tree?: boolean;
  showProject?: boolean;
  reorderable?: boolean;
  /** Rows can be dragged (e.g. onto a date or project) without reordering on drop. */
  draggable?: boolean;
  ariaLabel: string;
  /** Hide the meta line date when the group heading already shows it. */
  hideDate?: boolean;
}

export function TaskList({ tasks, tree = true, showProject = false, reorderable = false, draggable = false, ariaLabel, hideDate = false }: TaskListProps) {
  const app = useApp();
  const today = useToday();
  const prefs = useDatePrefs();
  const selectionArr = useUi((s) => s.selection);
  const selection = useMemo(() => new Set(selectionArr), [selectionArr]);
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>({});

  const labels = useQuery(() => new Map(app.repos.labels.list().map((l) => [l.id, l])), []);
  const projects = useQuery(() => new Map(app.repos.projects.list({ includeArchived: true }).map((p) => [p.id, p])), []);
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const progress = useQuery(() => app.repos.tasks.progressFor(ids), [ids]);
  const comments = useQuery(() => app.repos.comments.countsForTasks(), []);
  const attachments = useQuery(
    () => new Set(app.repos.db.all<{ task_id: string }>('SELECT DISTINCT task_id FROM attachments WHERE deleted_at IS NULL AND task_id IS NOT NULL').map((r) => r.task_id)),
    [],
  );
  const blocked = useQuery(() => app.repos.dependencies.blockedIds(ids), [ids]);

  const rows: TaskNode[] = useMemo(() => {
    if (!tree) return tasks.map((t) => ({ task: t, depth: 0, children: [] }));
    return flattenTree(buildTree(tasks), (t) => localCollapsed[t.id] ?? t.collapsed);
  }, [tasks, tree, localCollapsed]);

  const ctx: Ctx = useMemo(
    () => ({ labels, projects, progress, comments, attachments, blocked, today, prefs, showProject, reorderable, draggable: draggable || reorderable, selection }),
    [labels, projects, progress, comments, attachments, blocked, today, prefs, showProject, reorderable, draggable, selection],
  );
  const listRef = useRef<HTMLUListElement>(null);
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const scrollToIndexRef = useRef<((i: number) => void) | null>(null);

  const onArrow = useCallback(
    (index: number, delta: number) => {
      const target = Math.max(0, Math.min(index + delta, rows.length - 1));
      const find = () => listRef.current?.querySelector<HTMLElement>(`[data-row-index="${target}"]`);
      if (find()) return find()!.focus();
      // Virtualised: bring the row into the window first, then focus it.
      scrollToIndexRef.current?.(target);
      requestAnimationFrame(() => find()?.focus());
    },
    [rows.length],
  );

  const onToggleCollapse = useCallback(
    (id: string, current: boolean) => {
      setLocalCollapsed((c) => ({ ...c, [id]: !current }));
      app.repos.tasks.update(id, { collapsed: !current });
    },
    [app],
  );

  const rangeSelect = useCallback(
    (id: string) => {
      const { lastSelected, selection: sel, setSelection } = useUi.getState();
      const order = rows.map((r) => r.task.id);
      const a = lastSelected ? order.indexOf(lastSelected) : -1;
      const b = order.indexOf(id);
      if (a < 0 || b < 0) return setSelection([...new Set([...sel, id])], id);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelection([...new Set([...sel, ...order.slice(from, to + 1)])], id);
    },
    [rows],
  );

  if (rows.length === 0) return null;
  const renderRow = (n: TaskNode, i: number, extra?: { style: CSSProperties; measureRef: (el: HTMLLIElement | null) => void }) => (
    <TaskRow
      key={n.task.id}
      node={n}
      index={i}
      ctx={ctx}
      hideDate={hideDate}
      siblings={tasks}
      collapsed={localCollapsed[n.task.id] ?? n.task.collapsed}
      onToggleCollapse={onToggleCollapse}
      onArrow={onArrow}
      onRangeSelect={rangeSelect}
      style={extra?.style}
      measureRef={extra?.measureRef}
    />
  );
  if (virtual) {
    return <VirtualRows listRef={listRef} rows={rows} ariaLabel={ariaLabel} renderRow={renderRow} scrollToIndexRef={scrollToIndexRef} />;
  }
  return (
    <ul ref={listRef} aria-label={ariaLabel} className="flex flex-col">
      {rows.map((n, i) => renderRow(n, i))}
    </ul>
  );
}

/** Lists longer than this render only the rows near the viewport (spec 7.5). */
const VIRTUALIZE_AFTER = 150;

function VirtualRows({
  listRef,
  rows,
  ariaLabel,
  renderRow,
  scrollToIndexRef,
}: {
  listRef: React.RefObject<HTMLUListElement | null>;
  rows: TaskNode[];
  ariaLabel: string;
  renderRow: (n: TaskNode, i: number, extra: { style: CSSProperties; measureRef: (el: HTMLLIElement | null) => void }) => React.ReactNode;
  scrollToIndexRef: React.RefObject<((i: number) => void) | null>;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  // Runs after every render on purpose (content above the list can change height);
  // the equality guards inside stop it from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const list = listRef.current;
    const root = list?.closest<HTMLElement>('[data-scroll-root]') ?? null;
    if (root !== scrollEl) setScrollEl(root);
    if (list && root) {
      // Distance from the top of the scroll container to the list (content above it scrolls too).
      const m = Math.round(list.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop);
      if (Math.abs(m - margin) > 1) setMargin(m);
    }
  });
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 62,
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (i) => rows[i]!.task.id,
  });
  scrollToIndexRef.current = (i) => v.scrollToIndex(i, { align: 'auto' });
  return (
    <ul ref={listRef} aria-label={ariaLabel} aria-rowcount={rows.length} className="relative" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((item) =>
        renderRow(rows[item.index]!, item.index, {
          style: { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start - margin}px)` },
          measureRef: v.measureElement,
        }),
      )}
    </ul>
  );
}

interface RowProps {
  node: TaskNode;
  index: number;
  ctx: Ctx;
  hideDate: boolean;
  siblings: readonly Task[];
  collapsed: boolean;
  onToggleCollapse: (id: string, current: boolean) => void;
  onArrow: (index: number, delta: number) => void;
  onRangeSelect: (id: string) => void;
  style?: CSSProperties;
  measureRef?: (el: HTMLLIElement | null) => void;
}

const TaskRow = memo(function TaskRow({ node, index, ctx, hideDate, siblings, collapsed, onToggleCollapse: toggle, onArrow: arrow, onRangeSelect, style, measureRef }: RowProps) {
  const { task, depth, children } = node;
  const onToggleCollapse = () => toggle(task.id, collapsed);
  const onArrow = (d: number) => arrow(index, d);
  const app = useApp();
  const act = useAction();
  const toggleSelected = useUi((s) => s.toggleSelected);
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const [completing, setCompleting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const swipeStart = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const datePop = usePopover();
  const menu = usePopover();
  const prioPop = usePopover();
  const movePop = usePopover();
  const statusPop = usePopover();

  const open = isOpenStatus(task.status);
  const selected = ctx.selection.has(task.id);
  const prog = ctx.progress.get(task.id);
  const project = task.projectId ? ctx.projects.get(task.projectId) : undefined;
  const taskLabels = task.labelIds.map((id) => ctx.labels.get(id)).filter((l): l is Label => !!l);
  const commentCount = ctx.comments.get(task.id) ?? 0;

  const complete = () => {
    if (!open) {
      act(() => app.tasks.reopen(task.id));
      return;
    }
    setCompleting(true);
    navigator.vibrate?.(10);
    setTimeout(() => {
      act((force) => app.tasks.complete(task.id, { force }));
      setCompleting(false);
    }, 220);
  };

  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') onArrow(1);
    else if (k === 'ArrowUp' || k === 'k') onArrow(-1);
    else if (k === 'Enter') openTask(task.id);
    else if (k === 'x') toggleSelected(task.id);
    else if (k === 'e') complete();
    else if (k === 'Delete' || k === 'Backspace') act(() => app.tasks.remove([task.id]));
    else if (['1', '2', '3', '4'].includes(k)) act(() => app.tasks.update(task.id, { priority: Number(k) as Priority }));
    else if (k === 'ArrowRight' && children.length && collapsed) onToggleCollapse();
    else if (k === 'ArrowLeft' && children.length && !collapsed) onToggleCollapse();
    else return;
    e.preventDefault();
  };

  // Touch swipe: right = complete, left = schedule. Mouse users get hover buttons instead.
  const onPointerDown = (e: RPointerEvent) => {
    if (e.pointerType !== 'touch') return;
    swipeStart.current = { x: e.clientX, y: e.clientY, active: false };
  };
  const onPointerMove = (e: RPointerEvent) => {
    const s = swipeStart.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) s.active = true;
    if (s.active) setSwipe(Math.max(-120, Math.min(120, dx)));
  };
  const onPointerEnd = () => {
    const s = swipeStart.current;
    swipeStart.current = null;
    if (s?.active) {
      if (swipe > 80) complete();
      else if (swipe < -80) datePop.show();
    }
    setSwipe(0);
  };

  const dragStart = ctx.draggable
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData(DRAG_MIME, task.id);
          e.dataTransfer.setData('text/plain', task.title);
          e.dataTransfer.effectAllowed = 'move';
        },
      }
    : {};
  const dragProps = ctx.reorderable
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) {
            e.preventDefault();
            setDragOver(true);
          }
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e: React.DragEvent) => {
          setDragOver(false);
          const id = e.dataTransfer.getData(DRAG_MIME);
          if (!id || id === task.id) return;
          e.preventDefault();
          e.stopPropagation();
          act(() =>
            app.repos.db.transaction(() => {
              const dragged = app.repos.tasks.get(id);
              if (!dragged) return;
              if (dragged.parentId !== task.parentId || dragged.projectId !== task.projectId || dragged.sectionId !== task.sectionId) {
                app.tasks.update(id, { projectId: task.projectId, sectionId: task.sectionId, parentId: task.parentId });
              }
              const sibs = siblings.filter((s) => s.parentId === task.parentId && s.sectionId === task.sectionId);
              app.tasks.reorder(id, task.id, sibs);
            }),
          );
        },
      }
    : {};

  return (
    <li
      ref={measureRef}
      style={style}
      data-index={index}
      data-row-index={index}
      data-task-row
      tabIndex={0}
      aria-label={`${task.title}${open ? '' : ', completed'}`}
      aria-selected={selected || undefined}
      onKeyDown={onKey}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (e.metaKey || e.ctrlKey) toggleSelected(task.id);
        else if (e.shiftKey) onRangeSelect(task.id);
        else if (ctx.selection.size) toggleSelected(task.id);
        else openTask(task.id);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      {...dragStart}
      {...dragProps}
      className={cx(
        'group relative cursor-pointer border-b border-line outline-none focus-visible:bg-surface-2',
        selected && 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
        dragOver && 'shadow-[inset_0_2px_0_var(--accent)]',
      )}
    >
      {swipe !== 0 && (
        <div className={cx('absolute inset-0 flex items-center px-5 text-white', swipe > 0 ? 'justify-start bg-ok' : 'justify-end bg-p3')} aria-hidden>
          {swipe > 0 ? <Check size={20} /> : <CalendarDays size={20} />}
        </div>
      )}
      <div
        className="relative flex items-start gap-2 bg-bg py-2.5 pr-2 transition-transform"
        style={{ paddingLeft: 4 + depth * 24, transform: swipe ? `translateX(${swipe}px)` : undefined, background: selected ? 'transparent' : undefined }}
      >
        <span className="flex w-5 shrink-0 justify-center pt-0.5">
          {children.length > 0 && (
            <button
              type="button"
              aria-label={collapsed ? `Expand ${children.length} subtasks` : 'Collapse subtasks'}
              aria-expanded={!collapsed}
              onClick={onToggleCollapse}
              className="flex h-5 w-5 items-center justify-center rounded text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <ChevronRight size={14} className={cx('transition-transform', !collapsed && 'rotate-90')} />
            </button>
          )}
        </span>
        <button
          type="button"
          role="checkbox"
          aria-checked={!open || completing}
          aria-label={open ? `Complete ${task.title}` : `Reopen ${task.title}`}
          onClick={complete}
          className="-m-2 flex shrink-0 items-center justify-center p-2 max-lg:-m-2.5 max-lg:p-2.5"
        >
          <span
            className={cx(
              'flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.6px] transition-colors',
              (completing || !open) && 'anim-check',
            )}
            style={{
              borderColor: PRIORITY_COLOR[task.priority],
              background: completing || !open ? PRIORITY_COLOR[task.priority] : `color-mix(in srgb, ${PRIORITY_COLOR[task.priority]} ${task.priority < 4 ? 12 : 0}%, transparent)`,
            }}
          >
            <Check size={11} strokeWidth={3} className={cx('text-white transition-opacity', completing || !open ? 'opacity-100' : 'opacity-0 group-hover:opacity-0')} />
          </span>
        </button>
        <div className="min-w-0 flex-1 pl-1">
          <div className={cx('break-words leading-snug', !open && 'text-muted line-through')}>{task.title}</div>
          {task.description && <div className="mt-0.5 line-clamp-1 text-[0.84rem] text-muted">{task.description}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] empty:hidden">
            {!hideDate && <ScheduledChip task={task} today={ctx.today} prefs={ctx.prefs} />}
            {hideDate && task.scheduledTime && (
              <span className="inline-flex items-center gap-1 text-muted">
                <Clock size={12} aria-hidden /> {formatTime(task.scheduledTime, ctx.prefs)}
              </span>
            )}
            <DeadlineChip deadline={task.deadline} today={ctx.today} prefs={ctx.prefs} />
            <DurationChip minutes={task.durationMinutes} />
            {ctx.blocked.has(task.id) && open && (
              <span className="inline-flex items-center gap-1 text-warn" title="Waiting on unfinished tasks">
                <Lock size={12} aria-hidden /> Blocked
              </span>
            )}
            {task.startDate && task.startDate > ctx.today && (
              <span className="inline-flex items-center gap-1 text-muted" title="Start date">
                <CalendarRange size={12} aria-hidden /> Starts {formatRelativeDate(task.startDate, ctx.today, ctx.prefs)}
              </span>
            )}
            {task.status === 'waiting' && (
              <span className="inline-flex items-center gap-1 text-p3">
                <Hourglass size={12} aria-hidden /> Waiting
              </span>
            )}
            {task.status === 'in_progress' && (
              <span className="inline-flex items-center gap-1 text-accent">
                <CircleDot size={12} aria-hidden /> In progress
              </span>
            )}
            {prog && prog.total > 0 && (
              <span className="inline-flex items-center gap-1 text-muted">
                <ProgressRing done={prog.done} total={prog.total} size={12} /> {prog.done}/{prog.total}
              </span>
            )}
            {commentCount > 0 && (
              <span className="inline-flex items-center gap-1 text-muted">
                <MessageSquare size={12} aria-hidden /> {commentCount}
              </span>
            )}
            {ctx.attachments.has(task.id) && <Paperclip size={12} className="text-muted" aria-label="Has attachments" />}
            {taskLabels.map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
            {ctx.showProject && (
              <span className="ml-auto inline-flex items-center gap-1 text-muted">
                {project ? (
                  <>
                    <ProjectIcon icon={project.icon} color={project.color} size={12} /> {project.name}
                  </>
                ) : (
                  'Inbox'
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="max-lg:hidden lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
            <RowIconButton refEl={datePop.ref} label="Schedule" onClick={datePop.toggle}>
              <CalendarDays size={15} />
            </RowIconButton>
          </span>
          <span className="lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
            <RowIconButton refEl={menu.ref} label="More actions" onClick={menu.toggle}>
              <Ellipsis size={16} />
            </RowIconButton>
          </span>
        </div>
      </div>

      <DatePopover
        anchor={datePop.ref}
        open={datePop.open}
        onClose={datePop.hide}
        value={task.scheduledDate}
        onChange={(d) => act((force) => app.tasks.update(task.id, { scheduledDate: d }, { force }))}
        allowTime
        time={task.scheduledTime}
        onTimeChange={(t) => act(() => app.tasks.update(task.id, { scheduledTime: t }))}
      />
      <Popover anchor={menu.ref} open={menu.open} onClose={menu.hide} label="Task actions" width={230}>
        <div role="menu" className="py-1">
          <MenuItem icon={<PencilLine size={15} />} onClick={() => (menu.hide(), openTask(task.id))} shortcut="Enter">
            Open details
          </MenuItem>
          <MenuItem icon={<PriorityFlag p={task.priority} />} onClick={() => (menu.hide(), prioPop.show())}>
            Priority
          </MenuItem>
          <MenuItem icon={<CircleDot size={15} />} onClick={() => (menu.hide(), statusPop.show())}>
            Status: {STATUS_LABELS[task.status]}
          </MenuItem>
          <MenuItem icon={<FolderInput size={15} />} onClick={() => (menu.hide(), movePop.show())}>
            Move to…
          </MenuItem>
          <MenuItem icon={<ListPlus size={15} />} onClick={() => (menu.hide(), openQuickAdd({ parentId: task.id }))}>
            Add subtask
          </MenuItem>
          {task.parentId && (
            <MenuItem icon={<ArrowUpLeft size={15} />} onClick={() => (menu.hide(), act(() => app.tasks.promote(task.id)))}>
              Make independent task
            </MenuItem>
          )}
          <MenuItem icon={<Copy size={15} />} onClick={() => (menu.hide(), act(() => app.tasks.duplicate(task.id), { success: 'Task duplicated' }))}>
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => (menu.hide(), act(() => app.tasks.remove([task.id])))} shortcut="Del">
            Delete
          </MenuItem>
        </div>
      </Popover>
      <PriorityPopover anchor={menu.ref} open={prioPop.open} onClose={prioPop.hide} value={task.priority} onChange={(p) => act(() => app.tasks.update(task.id, { priority: p }))} />
      <ProjectPopover
        anchor={menu.ref}
        open={movePop.open}
        onClose={movePop.hide}
        value={{ projectId: task.projectId, sectionId: task.sectionId }}
        onChange={(v) => act(() => app.tasks.move([task.id], v))}
      />
      <Popover anchor={menu.ref} open={statusPop.open} onClose={statusPop.hide} label="Status" width={200}>
        <div role="menu" className="py-1">
          {TASK_STATUSES.map((s: TaskStatus) => (
            <MenuItem key={s} active={s === task.status} onClick={() => (statusPop.hide(), act(() => app.tasks.setStatus(task.id, s)))}>
              {STATUS_LABELS[s]}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </li>
  );
});

function RowIconButton({ refEl, label, onClick, children }: { refEl: React.RefObject<HTMLButtonElement | null>; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      ref={refEl}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg max-lg:h-9 max-lg:w-9"
    >
      {children}
    </button>
  );
}
