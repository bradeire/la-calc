import { useState, type ReactNode } from 'react';
import {
  CalendarDays, CalendarRange, ChevronRight, CircleAlert, CloudCheck, Filter, Inbox, LoaderCircle, PanelLeftClose, Plus, Search, Settings, Star,
  Sun, Tag, Target, Trash2, Workflow,
} from 'lucide-react';
import type { Project } from '@/core/domain/types';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useQuery, useToday } from '../hooks';
import { go, quickAddDefaultsFor, useLocation, type Route } from '../router';
import { IconButton, cx } from '../primitives';
import { DRAG_MIME } from '../components/TaskList';
import { ProjectIcon } from '../components/meta';
import { orderProjects } from '../components/pickers';
import { ProjectDialog } from '../components/ProjectDialog';
import { useSaveStatus } from './useSaveStatus';

function NavItem({
  icon,
  label,
  route,
  count,
  active,
  onDropTask,
  depth = 0,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  route: Route;
  count?: number;
  active: boolean;
  onDropTask?: (taskId: string) => void;
  depth?: number;
  trailing?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx('group flex items-center rounded-lg', active ? 'bg-surface-3 text-fg' : 'text-fg/85 hover:bg-surface-2', over && 'ring-2 ring-accent')}
      onDragOver={(e) => {
        if (onDropTask && e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_MIME);
        if (id && onDropTask) {
          e.preventDefault();
          onDropTask(id);
        }
      }}
    >
      {trailing}
      <button
        type="button"
        onClick={() => go(route)}
        aria-current={active ? 'page' : undefined}
        className="flex h-8 min-w-0 flex-1 items-center gap-2.5 px-2 text-left text-[0.92rem]"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span className="flex w-4 shrink-0 justify-center">{icon}</span>
        <span className="truncate">{label}</span>
        {count ? <span className="ml-auto text-[0.78rem] text-subtle">{count}</span> : null}
      </button>
    </div>
  );
}

export function Sidebar() {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const loc = useLocation();
  const r = loc.route;
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const inboxCount = useQuery(() => app.repos.tasks.countOpen('inbox'), []);
  const todayCount = useQuery(() => app.repos.tasks.countOpen({ today }), [today]);
  const projects = useQuery(() => orderProjects(app.repos.projects.list()), []);
  const stats = useQuery(() => app.repos.projects.stats(), []);
  const favourites = projects.filter((p) => p.isFavorite);
  const pinnedFilters = useQuery(() => app.filters.list().filter((f) => f.isFavorite), []);
  const hasChildren = (id: string) => projects.some((p) => p.parentId === id);
  const isHidden = (p: Project): boolean => {
    let cur = p.parentId ? projects.find((x) => x.id === p.parentId) : undefined;
    while (cur) {
      if (collapsed[cur.id] ?? cur.collapsed) return true;
      cur = cur.parentId ? projects.find((x) => x.id === cur!.parentId) : undefined;
    }
    return false;
  };
  const depthOf = (p: Project) => {
    let d = 0;
    let cur = p;
    while (cur.parentId && d < 10) {
      const next = projects.find((x) => x.id === cur.parentId);
      if (!next) break;
      d++;
      cur = next;
    }
    return d;
  };
  const moveTo = (projectId: string | null) => (taskId: string) => act(() => app.tasks.move([taskId], { projectId }));

  return (
    <aside aria-label="Main navigation" className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-surface-2/60">
      <div className="flex h-12 items-center justify-between px-3">
        <span className="flex items-center gap-2 text-[1rem] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Target size={15} strokeWidth={2.5} />
          </span>
          Focus
        </span>
        <IconButton size="sm" label="Collapse sidebar" onClick={toggleSidebar}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      <div className="flex gap-1.5 px-3 pb-2">
        <button
          type="button"
          onClick={() => openQuickAdd(quickAddDefaultsFor(r, today))}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg px-2 text-[0.92rem] font-medium text-accent hover:bg-surface-2"
        >
          <Plus size={17} strokeWidth={2.4} /> Add task
          <kbd className="ml-auto text-[0.72rem] font-normal text-subtle">Q</kbd>
        </button>
        <IconButton size="sm" label="Search (/)" onClick={() => go({ name: 'search', q: '' })} className="h-8 w-8">
          <Search size={16} />
        </IconButton>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-thin">
        <div className="flex flex-col gap-px">
          <NavItem icon={<Inbox size={16} className="text-p3" />} label="Inbox" route={{ name: 'inbox' }} count={inboxCount} active={r.name === 'inbox'} onDropTask={moveTo(null)} />
          <NavItem
            icon={<Sun size={16} className="text-ok" />}
            label="Today"
            route={{ name: 'today' }}
            count={todayCount}
            active={r.name === 'today'}
            onDropTask={(id) => act((force) => app.tasks.update(id, { scheduledDate: today }, { force }))}
          />
          <NavItem icon={<CalendarRange size={16} className="text-violet-500" />} label="Upcoming" route={{ name: 'upcoming' }} active={r.name === 'upcoming'} />
          <NavItem icon={<CalendarDays size={16} className="text-warn" />} label="Calendar" route={{ name: 'calendar' }} active={r.name === 'calendar'} />
          <NavItem icon={<Target size={16} className="text-danger" />} label="Focus" route={{ name: 'focus' }} active={r.name === 'focus'} />
          <NavItem icon={<Filter size={16} className="text-p3" />} label="Filters" route={{ name: 'filters' }} active={r.name === 'filters' || r.name === 'filterEdit'} />
          <NavItem icon={<Workflow size={16} className="text-violet-500" />} label="Automations" route={{ name: 'automations' }} active={r.name === 'automations' || r.name === 'automationEdit'} />
          <NavItem icon={<Tag size={16} className="text-muted" />} label="Labels" route={{ name: 'labels' }} active={r.name === 'labels' || r.name === 'label'} />
        </div>

        {(favourites.length > 0 || pinnedFilters.length > 0) && (
          <div className="mt-4">
            <h3 className="flex items-center gap-1 px-2 pb-1 text-[0.75rem] font-semibold uppercase tracking-wide text-subtle">
              <Star size={11} /> Favourites
            </h3>
            {favourites.map((p) => (
              <NavItem
                key={p.id}
                icon={<ProjectIcon icon={p.icon} color={p.color} />}
                label={p.name}
                route={{ name: 'project', id: p.id }}
                count={stats.get(p.id)?.open}
                active={r.name === 'project' && r.id === p.id}
                onDropTask={moveTo(p.id)}
              />
            ))}
            {pinnedFilters.map((f) => (
              <NavItem key={f.id} icon={<Filter size={15} style={{ color: f.color }} />} label={f.name} route={{ name: 'filter', id: f.id }} active={r.name === 'filter' && r.id === f.id} />
            ))}
          </div>
        )}

        <div className="mt-4">
          <div className="flex items-center justify-between px-2 pb-1">
            <button type="button" onClick={() => go({ name: 'projects' })} className="text-[0.75rem] font-semibold uppercase tracking-wide text-subtle hover:text-fg">
              Projects
            </button>
            <IconButton size="sm" label="New project" onClick={() => setCreating(true)} className="h-6 w-6">
              <Plus size={14} />
            </IconButton>
          </div>
          {projects.length === 0 && <p className="px-2 py-1 text-[0.85rem] text-subtle">No projects yet.</p>}
          {projects
            .filter((p) => !isHidden(p))
            .map((p) => (
              <NavItem
                key={p.id}
                icon={<ProjectIcon icon={p.icon} color={p.color} />}
                label={p.name}
                route={{ name: 'project', id: p.id }}
                count={stats.get(p.id)?.open}
                active={r.name === 'project' && r.id === p.id}
                onDropTask={moveTo(p.id)}
                depth={depthOf(p)}
                trailing={
                  hasChildren(p.id) ? (
                    <button
                      type="button"
                      aria-label={(collapsed[p.id] ?? p.collapsed) ? `Expand ${p.name}` : `Collapse ${p.name}`}
                      onClick={() => {
                        const next = !(collapsed[p.id] ?? p.collapsed);
                        setCollapsed((c) => ({ ...c, [p.id]: next }));
                        app.repos.projects.update(p.id, { collapsed: next });
                      }}
                      className="-mr-1 flex h-8 w-5 items-center justify-center text-subtle hover:text-fg"
                      style={{ marginLeft: depthOf(p) * 14 }}
                    >
                      <ChevronRight size={13} className={cx('transition-transform', !(collapsed[p.id] ?? p.collapsed) && 'rotate-90')} />
                    </button>
                  ) : undefined
                }
              />
            ))}
        </div>
      </nav>
      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <NavFooterButton icon={<Settings size={16} />} label="Settings" onClick={() => go({ name: 'settings' })} active={r.name === 'settings'} />
        <NavFooterButton icon={<Trash2 size={16} />} label="Trash" onClick={() => go({ name: 'trash' })} active={r.name === 'trash'} />
        <SaveIndicator />
      </div>
      <ProjectDialog open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}

function NavFooterButton({ icon, label, onClick, active }: { icon: ReactNode; label: string; onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-8 items-center gap-2 rounded-lg px-2 text-[0.88rem]', active ? 'bg-surface-3' : 'text-muted hover:bg-surface-2 hover:text-fg')}
    >
      {icon} {label}
    </button>
  );
}

export function SaveIndicator({ compact }: { compact?: boolean }) {
  const { status, error } = useSaveStatus();
  const text = status === 'error' ? `Not saved: ${error ?? 'storage error'}` : status === 'saved' ? 'All changes saved on this device' : 'Saving…';
  return (
    <span className={cx('ml-auto flex items-center gap-1 px-1 text-[0.75rem]', status === 'error' ? 'text-danger' : 'text-subtle')} title={text} role="status" aria-label={text}>
      {status === 'error' ? <CircleAlert size={14} /> : status === 'saved' ? <CloudCheck size={14} /> : <LoaderCircle size={14} className="animate-spin" />}
      {!compact && status === 'error' && 'Not saved'}
    </span>
  );
}
