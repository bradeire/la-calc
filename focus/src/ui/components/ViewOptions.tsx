import { useMemo, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, SlidersHorizontal } from 'lucide-react';
import type { Task } from '@/core/domain/types';
import {
  DEFAULT_VIEW_OPTIONS, describeOptions, GROUP_KEYS, GROUP_LABELS, groupTasks, SORT_KEYS, SORT_LABELS, sortTasks,
  type GroupKey, type Lookups, type SortKey, type ViewOptions,
} from '@/core/view-options';
import { useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { Button, Popover, Select, cx } from '../primitives';
import { GroupHeading } from './common';
import { orderProjects, usePopover } from './pickers';
import { TaskList, type TaskListProps } from './TaskList';

/** The saved sort/group options for one view (this device only). */
export function useViewOptions(viewId: string): [ViewOptions, (o: ViewOptions) => void] {
  const app = useApp();
  const all = useQuery(() => app.repos.settings.getAll().viewOptions, []);
  const opts = all[viewId] ?? DEFAULT_VIEW_OPTIONS;
  const set = (o: ViewOptions) => {
    const next = { ...app.repos.settings.getAll().viewOptions };
    if (o.sort === 'manual' && o.dir === 'asc' && o.group === 'none') delete next[viewId];
    else next[viewId] = o;
    app.repos.settings.set('viewOptions', next);
  };
  return [opts, set];
}

function useLookups(): Lookups {
  const app = useApp();
  const today = useToday();
  const prefs = useDatePrefs();
  const projects = useQuery(() => orderProjects(app.repos.projects.list({ includeArchived: true })), []);
  const labels = useQuery(() => app.repos.labels.list(), []);
  return useMemo(() => {
    const order = new Map(projects.map((p, i) => [p.id, i + 1]));
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const labelNames = new Map(labels.map((l) => [l.id, l.name]));
    return {
      projectName: (id) => (id ? (names.get(id) ?? 'Unknown project') : 'Inbox'),
      projectOrder: (id) => (id ? (order.get(id) ?? 9999) : 0),
      labelName: (id) => labelNames.get(id) ?? null,
      today,
      prefs,
    };
  }, [projects, labels, today, prefs]);
}

/** "Sort & group" button for a view header. */
export function ViewOptionsButton({ viewId, groups = GROUP_KEYS }: { viewId: string; groups?: readonly GroupKey[] }) {
  const [opts, setOpts] = useViewOptions(viewId);
  const pop = usePopover();
  const summary = describeOptions(opts);
  return (
    <>
      <Button ref={pop.ref} size="sm" variant="ghost" onClick={pop.toggle} aria-label={summary ? `Sort and group: ${summary}` : 'Sort and group'} title="Sort and group">
        <SlidersHorizontal size={14} className={cx(summary && 'text-accent')} />
        <span className="max-sm:hidden">{summary ? 'Sorted' : 'Sort'}</span>
      </Button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.hide} label="Sort and group" width={280}>
        <div className="flex flex-col gap-3 p-3 text-[0.88rem]">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Sort by</span>
            <span className="flex items-center gap-1">
              <Select aria-label="Sort by" value={opts.sort} onChange={(e) => setOpts({ ...opts, sort: e.target.value as SortKey })} className="flex-1">
                {SORT_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="ghost"
                aria-label={opts.dir === 'asc' ? 'Ascending (tap for descending)' : 'Descending (tap for ascending)'}
                title={opts.dir === 'asc' ? 'Ascending' : 'Descending'}
                onClick={() => setOpts({ ...opts, dir: opts.dir === 'asc' ? 'desc' : 'asc' })}
              >
                {opts.dir === 'asc' ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
              </Button>
            </span>
            <span className="text-[0.78rem] text-subtle">{dirHint(opts)}</span>
          </label>
          {groups.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-muted">Group by</span>
            <Select aria-label="Group by" value={opts.group} onChange={(e) => setOpts({ ...opts, group: e.target.value as GroupKey })}>
              {groups.map((k) => (
                <option key={k} value={k}>
                  {GROUP_LABELS[k]}
                </option>
              ))}
            </Select>
          </label>
          )}
          {summary && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpts(DEFAULT_VIEW_OPTIONS)}>
              Reset to your order
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}

function dirHint(o: ViewOptions): string {
  const asc = o.dir === 'asc';
  switch (o.sort) {
    case 'deadline':
    case 'scheduled':
      return asc ? 'Soonest first; tasks without a date last' : 'Latest first; tasks without a date last';
    case 'created':
      return asc ? 'Oldest first' : 'Newest first';
    case 'name':
      return asc ? 'A to Z' : 'Z to A';
    case 'priority':
      return asc ? 'P1 first' : 'P4 first';
    case 'project':
      return asc ? 'In sidebar order' : 'Reverse sidebar order';
    default:
      return asc ? 'The order you dragged tasks into' : 'Your order, reversed';
  }
}

/**
 * A task list with the view's sort and grouping applied. With the default options it is exactly
 * the plain TaskList (drag-to-reorder still works); otherwise reordering is off, since the order
 * comes from the sort.
 */
export function OrganisedTaskList({
  viewId,
  tasks,
  empty,
  ...list
}: TaskListProps & { viewId: string; empty?: ReactNode }) {
  const [opts] = useViewOptions(viewId);
  const l = useLookups();
  const sorted = useMemo(() => sortTasks(tasks, opts, l), [tasks, opts, l]);
  const groups = useMemo(() => groupTasks(sorted, opts.group, l), [sorted, opts.group, l]);
  const manual = opts.sort === 'manual' && opts.dir === 'asc';
  if (!tasks.length) return <>{empty}</>;
  if (opts.group === 'none') return <TaskList {...list} tasks={sorted} reorderable={list.reorderable && manual} />;
  return (
    <>
      {groups.map((g) => (
        <GroupHeading key={g.key} title={g.title} count={g.tasks.filter((t) => !t.parentId || !g.tasks.some((p) => p.id === t.parentId)).length} tone={g.tone} collapsible>
          <TaskList
            {...list}
            tasks={g.tasks}
            reorderable={false}
            showProject={list.showProject && opts.group !== 'project'}
            ariaLabel={`${list.ariaLabel}: ${g.title}`}
          />
        </GroupHeading>
      ))}
    </>
  );
}

/** Sort-only helper for views that already group (e.g. Upcoming's days). */
export function useSortedTasks(viewId: string, tasks: readonly Task[]): Task[] {
  const [opts] = useViewOptions(viewId);
  const l = useLookups();
  return useMemo(() => sortTasks(tasks, opts, l), [tasks, opts, l]);
}

/** A sort function for views that build their own groups (e.g. Upcoming sorts within each day). */
export function useTaskSorter(viewId: string): (tasks: readonly Task[]) => Task[] {
  const [opts] = useViewOptions(viewId);
  const l = useLookups();
  return useMemo(() => (tasks: readonly Task[]) => sortTasks(tasks, opts, l), [opts, l]);
}
