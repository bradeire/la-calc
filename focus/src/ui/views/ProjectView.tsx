import { useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, Columns3, Ellipsis, Eye, EyeOff, FolderPlus, LayoutList, CalendarDays, Pencil, Plus,
  StickyNote, Table2, Trash2,
} from 'lucide-react';
import { isOpenStatus, STATUS_LABELS, TASK_STATUSES, type Priority, type Project, type ProjectLayout, type Section, type Task, type TaskStatus } from '@/core/domain/types';
import { formatDuration, formatRelativeDate } from '@/core/dates';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { go, openTask } from '../router';
import { Button, ConfirmDialog, EmptyState, IconButton, Input, MenuItem, MenuSeparator, Popover, Select, Textarea, cx, usePrompt } from '../primitives';
import { AddTaskRow, GroupHeading, ViewBody } from '../components/common';
import { DRAG_MIME, TaskList } from '../components/TaskList';
import { ProjectDialog } from '../components/ProjectDialog';
import { usePopover } from '../components/pickers';
import { PRIORITY_COLOR, ProgressRing, ProjectIcon } from '../components/meta';
import { ViewHeader } from '../layout/Chrome';
import { CalendarView } from './CalendarView';

const LAYOUTS: { id: ProjectLayout; label: string; icon: typeof LayoutList }[] = [
  { id: 'list', label: 'List', icon: LayoutList },
  { id: 'board', label: 'Board', icon: Columns3 },
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
];

export function ProjectView({ id }: { id: string }) {
  const app = useApp();
  const act = useAction();
  const project = useQuery(() => app.repos.projects.get(id), [id]);
  const settings = useQuery(() => app.repos.settings.getAll(), []);
  const [showCompleted, setShowCompleted] = useState(settings.showCompletedInProjects);
  const tasks = useQuery(() => app.repos.tasks.listByProject(id, { includeClosed: showCompleted }), [id, showCompleted]);
  const sections = useQuery(() => app.repos.projects.listSections(id), [id]);
  const children = useQuery(() => app.repos.projects.list().filter((p) => p.parentId === id), [id]);
  const stats = useQuery(() => app.repos.projects.stats(), []);
  const [editing, setEditing] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const menu = usePopover();
  const prompt = usePrompt();

  if (!project || project.deletedAt) {
    return (
      <>
        <ViewHeader title="Project not found" />
        <EmptyState icon={<FolderPlus size={26} />} title="This project doesn’t exist" body={project?.deletedAt ? 'It is in Trash.' : undefined} action={<Button onClick={() => go({ name: 'projects' })}>All projects</Button>} />
      </>
    );
  }
  const s = stats.get(id);
  const total = (s?.open ?? 0) + (s?.completed ?? 0);
  const setLayout = (layout: ProjectLayout) => act(() => app.projects.update(id, { layout }));

  return (
    <>
      <ViewHeader
        title={project.name}
        icon={<ProjectIcon icon={project.icon} color={project.color} size={22} />}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            {total > 0 && <ProgressRing done={s?.completed ?? 0} total={total} size={12} />}
            {total > 0 ? `${s?.completed ?? 0} of ${total} done` : 'No tasks yet'}
            {project.archivedAt && ' · Archived'}
            {project.description && ` · ${project.description}`}
          </span>
        }
        actions={
          <>
            <div className="mr-1 hidden rounded-lg border border-line p-0.5 sm:flex" role="radiogroup" aria-label="Layout">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={project.layout === l.id}
                  aria-label={l.label}
                  title={l.label}
                  onClick={() => setLayout(l.id)}
                  className={cx('flex h-7 w-8 items-center justify-center rounded-md', project.layout === l.id ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}
                >
                  <l.icon size={15} />
                </button>
              ))}
            </div>
            <IconButton ref={menu.ref} label="Project actions" onClick={menu.toggle}>
              <Ellipsis size={18} />
            </IconButton>
          </>
        }
      />
      <Popover anchor={menu.ref} open={menu.open} onClose={menu.hide} label="Project actions" width={240}>
        <div role="menu" className="py-1">
          <div className="flex gap-1 px-2 py-1 sm:hidden">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" onClick={() => (setLayout(l.id), menu.hide())} className={cx('flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[0.75rem]', project.layout === l.id ? 'bg-surface-3' : 'text-muted')}>
                <l.icon size={18} />
                {l.label}
              </button>
            ))}
          </div>
          <MenuItem icon={<Pencil size={15} />} onClick={() => (menu.hide(), setEditing(true))}>Edit project</MenuItem>
          <MenuItem icon={<Plus size={15} />} onClick={() => { menu.hide(); void prompt.ask('Add section', 'Section name').then((name) => name && act(() => app.projects.addSection(id, name))); }}>
            Add section
          </MenuItem>
          <MenuItem icon={<FolderPlus size={15} />} onClick={() => (menu.hide(), setCreatingChild(true))}>Add sub-project</MenuItem>
          <MenuItem icon={<StickyNote size={15} />} onClick={() => (menu.hide(), setNotesOpen(true))}>Notes</MenuItem>
          <MenuItem icon={showCompleted ? <EyeOff size={15} /> : <Eye size={15} />} onClick={() => (menu.hide(), setShowCompleted(!showCompleted))}>
            {showCompleted ? 'Hide completed' : 'Show completed'}
          </MenuItem>
          <MenuSeparator />
          {project.archivedAt ? (
            <MenuItem icon={<ArchiveRestore size={15} />} onClick={() => (menu.hide(), act(() => app.projects.unarchive(id)))}>Unarchive</MenuItem>
          ) : (
            <MenuItem icon={<Archive size={15} />} onClick={() => (menu.hide(), act(() => app.projects.archive(id)))}>Archive</MenuItem>
          )}
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => (menu.hide(), setConfirmDelete(true))}>Delete project</MenuItem>
        </div>
      </Popover>

      {project.layout === 'calendar' ? (
        <CalendarView embedded projectId={id} />
      ) : (
        <ViewBody wide={project.layout !== 'list'}>
          {(notesOpen || project.notes) && <ProjectNotes project={project} startOpen={notesOpen} />}
          {children.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {children.map((c) => {
                const cs = stats.get(c.id);
                const ct = (cs?.open ?? 0) + (cs?.completed ?? 0);
                return (
                  <button key={c.id} type="button" onClick={() => go({ name: 'project', id: c.id })} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[0.88rem] hover:bg-surface-2">
                    <ProjectIcon icon={c.icon} color={c.color} size={14} /> {c.name}
                    {ct > 0 && <span className="text-[0.78rem] text-subtle">{cs?.completed}/{ct}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {project.layout === 'list' && <ListLayout project={project} tasks={tasks} sections={sections} />}
          {project.layout === 'board' && <BoardLayout project={project} tasks={tasks} sections={sections} />}
          {project.layout === 'table' && <TableLayout tasks={tasks} sections={sections} />}
        </ViewBody>
      )}

      {prompt.element}
      <ProjectDialog open={editing} onClose={() => setEditing(false)} project={project} />
      <ProjectDialog open={creatingChild} onClose={() => setCreatingChild(false)} parentId={id} />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${project.name}”?`}
        body={`The project${children.length ? ', its sub-projects' : ''} and ${total} task${total === 1 ? '' : 's'} will move to Trash. You can restore them from Trash.`}
        confirmLabel="Move to Trash"
        danger
        onConfirm={() => {
          act(() => app.projects.remove(id));
          go({ name: 'projects' });
        }}
      />
    </>
  );
}

function ProjectNotes({ project, startOpen }: { project: Project; startOpen: boolean }) {
  const app = useApp();
  const act = useAction();
  const [text, setText] = useState(project.notes);
  return (
    <GroupHeading title="Notes" collapsible defaultOpen={startOpen || !!project.notes}>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== project.notes && act(() => app.projects.update(project.id, { notes: text }))}
        placeholder="Project notes, links, reference information…"
        aria-label="Project notes"
        rows={Math.min(12, Math.max(3, text.split('\n').length))}
        className="mt-2"
      />
    </GroupHeading>
  );
}

function SectionActions({ section, isFirst, isLast }: { section: Section; isFirst: boolean; isLast: boolean }) {
  const app = useApp();
  const act = useAction();
  const menu = usePopover();
  const prompt = usePrompt();
  return (
    <>
      {prompt.element}
      <IconButton size="sm" ref={menu.ref} label={`Actions for section ${section.name}`} onClick={menu.toggle}>
        <Ellipsis size={15} />
      </IconButton>
      <Popover anchor={menu.ref} open={menu.open} onClose={menu.hide} label="Section actions" width={210}>
        <div role="menu" className="py-1">
          <MenuItem icon={<Pencil size={15} />} onClick={() => { menu.hide(); void prompt.ask('Rename section', 'Section name', section.name).then((n) => n && act(() => app.projects.renameSection(section.id, n))); }}>Rename</MenuItem>
          {!isFirst && <MenuItem icon={<ArrowUp size={15} />} onClick={() => (menu.hide(), act(() => app.projects.moveSection(section.id, -1)))}>Move up</MenuItem>}
          {!isLast && <MenuItem icon={<ArrowDown size={15} />} onClick={() => (menu.hide(), act(() => app.projects.moveSection(section.id, 1)))}>Move down</MenuItem>}
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={() => (menu.hide(), act(() => app.projects.removeSection(section.id)))}>Delete section (keep tasks)</MenuItem>
        </div>
      </Popover>
    </>
  );
}

function useSectionDrop(sectionId: string | null, projectId: string) {
  const app = useApp();
  const act = useAction();
  const [over, setOver] = useState(false);
  return {
    highlight: over,
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_MIME)) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      setOver(false);
      const tid = e.dataTransfer.getData(DRAG_MIME);
      if (tid) act(() => app.tasks.update(tid, { projectId, sectionId, parentId: null }));
    },
  };
}

function ListLayout({ project, tasks, sections }: { project: Project; tasks: Task[]; sections: Section[] }) {
  const app = useApp();
  const act = useAction();
  const [newSection, setNewSection] = useState('');
  const unsectioned = tasks.filter((t) => !t.sectionId || !sections.some((s) => s.id === t.sectionId));
  return (
    <>
      <TaskList tasks={unsectioned} reorderable ariaLabel={`${project.name} tasks`} />
      <AddTaskRow defaults={{ projectId: project.id }} />
      {sections.map((s, i) => (
        <SectionGroup key={s.id} section={s} tasks={tasks.filter((t) => t.sectionId === s.id)} project={project} isFirst={i === 0} isLast={i === sections.length - 1} />
      ))}
      <form
        className="mt-6 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (act(() => app.projects.addSection(project.id, newSection)) !== undefined) setNewSection('');
        }}
      >
        <Input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="New section name" aria-label="New section name" className="max-w-xs" />
        <Button type="submit" disabled={!newSection.trim()}>
          Add section
        </Button>
      </form>
    </>
  );
}

function SectionGroup({ section, tasks, project, isFirst, isLast }: { section: Section; tasks: Task[]; project: Project; isFirst: boolean; isLast: boolean }) {
  const drop = useSectionDrop(section.id, project.id);
  return (
    <GroupHeading
      title={section.name}
      count={tasks.filter((t) => !t.parentId && isOpenStatus(t.status)).length}
      collapsible
      defaultOpen={!section.collapsed}
      actions={<SectionActions section={section} isFirst={isFirst} isLast={isLast} />}
      onDragOver={drop.onDragOver}
      onDrop={drop.onDrop}
      highlight={drop.highlight}
    >
      <TaskList tasks={tasks} reorderable ariaLabel={`Section ${section.name}`} />
      <AddTaskRow defaults={{ projectId: project.id, sectionId: section.id }} />
    </GroupHeading>
  );
}

function BoardLayout({ project, tasks, sections }: { project: Project; tasks: Task[]; sections: Section[] }) {
  const app = useApp();
  const act = useAction();
  const columns: { id: string | null; name: string; section?: Section }[] = [
    { id: null, name: 'No section' },
    ...sections.map((s) => ({ id: s.id, name: s.name, section: s })),
  ];
  const [newSection, setNewSection] = useState('');
  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 lg:-mx-8 lg:px-8" role="list" aria-label="Board">
      {columns.map((c, i) => (
        <BoardColumn
          key={c.id ?? 'none'}
          project={project}
          column={c}
          tasks={tasks.filter((t) => (c.id ? t.sectionId === c.id : !t.sectionId || !sections.some((s) => s.id === t.sectionId)))}
          isFirst={i <= 1}
          isLast={i === columns.length - 1}
        />
      ))}
      <div className="w-72 shrink-0 snap-start">
        <form
          className="flex flex-col gap-2 rounded-xl border border-dashed border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (act(() => app.projects.addSection(project.id, newSection)) !== undefined) setNewSection('');
          }}
        >
          <Input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="New column" aria-label="New column name" />
          <Button type="submit" disabled={!newSection.trim()}>
            Add column
          </Button>
        </form>
      </div>
    </div>
  );
}

function BoardColumn({ project, column, tasks, isFirst, isLast }: { project: Project; column: { id: string | null; name: string; section?: Section }; tasks: Task[]; isFirst: boolean; isLast: boolean }) {
  const drop = useSectionDrop(column.id, project.id);
  const today = useToday();
  const prefs = useDatePrefs();
  const top = tasks.filter((t) => !t.parentId);
  const childCount = (id: string) => tasks.filter((t) => t.parentId === id).length;
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  if (column.id === null && top.length === 0) return null;
  return (
    <div
      role="listitem"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={cx('flex w-72 shrink-0 snap-start flex-col rounded-xl bg-surface-2/70 p-2', drop.highlight && 'ring-2 ring-accent')}
    >
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <h2 className="truncate text-[0.92rem] font-semibold">{column.name}</h2>
        <span className="text-[0.8rem] text-subtle">{top.length}</span>
        <span className="ml-auto">{column.section && <SectionActions section={column.section} isFirst={isFirst} isLast={isLast} />}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {top.map((t) => (
          <li
            key={t.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => openTask(t.id)}
            onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}
            tabIndex={0}
            className="cursor-pointer rounded-lg border border-line bg-surface p-2.5 shadow-card hover:border-line-strong"
          >
            <div className="flex items-start gap-2">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2" style={{ borderColor: PRIORITY_COLOR[t.priority] }} aria-hidden />
              <span className={cx('text-[0.92rem] leading-snug', !isOpenStatus(t.status) && 'text-muted line-through')}>{t.title}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-2.5 pl-4.5 text-[0.76rem] text-muted empty:hidden">
              {t.scheduledDate && <span>{formatRelativeDate(t.scheduledDate, today, prefs)}</span>}
              {t.deadline && <span className="text-warn">Due {formatRelativeDate(t.deadline, today, prefs)}</span>}
              {t.durationMinutes && <span>{formatDuration(t.durationMinutes)}</span>}
              {childCount(t.id) > 0 && <span>{childCount(t.id)} subtasks</span>}
              {t.status !== 'active' && t.status !== 'inbox' && <span>{STATUS_LABELS[t.status]}</span>}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => openQuickAdd({ projectId: project.id, sectionId: column.id })} className="mt-1.5 flex items-center gap-1.5 rounded-lg px-2 py-2 text-[0.88rem] text-subtle hover:bg-surface hover:text-accent">
        <Plus size={15} /> Add task
      </button>
    </div>
  );
}

type SortKey = 'title' | 'status' | 'priority' | 'scheduledDate' | 'deadline' | 'durationMinutes' | 'section';

function TableLayout({ tasks, sections }: { tasks: Task[]; sections: Section[] }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'priority', dir: 1 });
  const sectionName = (id: string | null) => sections.find((s) => s.id === id)?.name ?? '';
  const rows = useMemo(() => {
    const v = (t: Task): string | number => (sort.key === 'section' ? sectionName(t.sectionId) : ((t[sort.key] as string | number | null) ?? (sort.dir === 1 ? '￿' : '')));
    return [...tasks].sort((a, b) => (v(a) < v(b) ? -sort.dir : v(a) > v(b) ? sort.dir : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, sort, sections]);
  const H = ({ k, children }: { k: SortKey; children: string }) => (
    <th scope="col" aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className="px-2 py-2 text-left font-medium text-muted">
      <button type="button" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }))} className="hover:text-fg">
        {children} {sort.key === k ? (sort.dir === 1 ? '↑' : '↓') : ''}
      </button>
    </th>
  );
  if (!tasks.length) return <EmptyState icon={<Table2 size={26} />} title="No tasks in this project" action={<AddTaskRow />} />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] border-collapse text-[0.88rem]">
        <thead className="bg-surface-2">
          <tr>
            <H k="title">Task</H>
            <H k="section">Section</H>
            <H k="status">Status</H>
            <H k="priority">Priority</H>
            <H k="scheduledDate">Scheduled</H>
            <H k="deadline">Deadline</H>
            <H k="durationMinutes">Estimate</H>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-line hover:bg-surface-2/60">
              <td className="max-w-80 px-2 py-1.5">
                <button type="button" onClick={() => openTask(t.id)} className={cx('text-left hover:underline', !isOpenStatus(t.status) && 'text-muted line-through')}>
                  {t.parentId && <span className="text-subtle">↳ </span>}
                  {t.title}
                </button>
              </td>
              <td className="px-2 py-1.5 text-muted">{sectionName(t.sectionId)}</td>
              <td className="px-2 py-1.5">
                <Select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => act(() => app.tasks.setStatus(t.id, e.target.value as TaskStatus))} className="h-7 border-transparent bg-transparent text-[0.85rem] hover:border-line">
                  {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </Select>
              </td>
              <td className="px-2 py-1.5">
                <Select aria-label={`Priority of ${t.title}`} value={t.priority} onChange={(e) => act(() => app.tasks.update(t.id, { priority: Number(e.target.value) as Priority }))} className="h-7 border-transparent bg-transparent text-[0.85rem] hover:border-line" style={{ color: PRIORITY_COLOR[t.priority] }}>
                  {[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}
                </Select>
              </td>
              <td className="px-2 py-1.5">
                <input type="date" aria-label={`Scheduled date of ${t.title}`} value={t.scheduledDate ?? ''} onChange={(e) => act(() => app.tasks.update(t.id, { scheduledDate: e.target.value || null }))} className={cx('rounded bg-transparent px-1', t.scheduledDate && t.scheduledDate < today && 'text-danger')} />
              </td>
              <td className="px-2 py-1.5">
                <input type="date" aria-label={`Deadline of ${t.title}`} value={t.deadline ?? ''} onChange={(e) => act(() => app.tasks.update(t.id, { deadline: e.target.value || null }))} className={cx('rounded bg-transparent px-1', t.deadline && t.deadline < today && 'text-danger')} />
              </td>
              <td className="px-2 py-1.5 text-muted">{t.durationMinutes ? formatDuration(t.durationMinutes) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
