import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, Check, CircleCheck, Ellipsis, Filter, Flag, Workflow, FolderInput, Inbox, Menu, PanelLeftOpen, Plus, Search, Settings, Sun, Tag, Target, Trash2, X, BarChart3 } from 'lucide-react';
import { useUi } from '@/state/ui-store';
import { useAction, useApp, useIsDesktop, useToday } from '../hooks';
import { go, parseHash, quickAddDefaultsFor, useLocation } from '../router';
import { todayISO } from '@/core/dates';
import { Button, ConfirmDialog, Dialog, IconButton, Kbd, MenuItem, Popover, cx } from '../primitives';
import { DatePopover, PriorityPopover, ProjectPopover, usePopover } from '../components/pickers';
import { SaveIndicator } from './Sidebar';

/** Per-view header. On phones it is sticky with large touch targets. */
export function ViewHeader({ title, subtitle, icon, actions, wide }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const isDesktop = useIsDesktop();
  return (
    <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:backdrop-blur-none">
      <div className={cx('mx-auto flex min-h-14 items-center gap-2 px-4 lg:min-h-16 lg:px-8 lg:pt-4', wide ? 'max-w-5xl' : 'max-w-3xl')}>
        {isDesktop && collapsed && (
          <IconButton label="Open sidebar" onClick={toggleSidebar}>
            <PanelLeftOpen size={18} />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-[1.3rem] font-bold tracking-tight lg:text-[1.45rem]">
            {icon}
            {title}
          </h1>
          {subtitle && <p className="truncate text-[0.82rem] text-muted">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {!isDesktop && (
            <IconButton label="Search" onClick={() => go({ name: 'search', q: '' })}>
              <Search size={19} />
            </IconButton>
          )}
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const loc = useLocation();
  const r = loc.route.name;
  const more = usePopover();
  const items = [
    { name: 'today', label: 'Today', icon: Sun },
    { name: 'inbox', label: 'Inbox', icon: Inbox },
    { name: 'upcoming', label: 'Upcoming', icon: CalendarDays },
    { name: 'projects', label: 'Browse', icon: Menu },
  ] as const;
  const isBrowse = ['projects', 'project', 'labels', 'label', 'settings', 'trash', 'calendar', 'focus', 'search', 'filters', 'filter', 'filterEdit', 'automations', 'automationEdit', 'insights', 'timeLog'].includes(r);
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-xl items-stretch">
        {items.map((it) => {
          const active = it.name === 'projects' ? isBrowse : r === it.name;
          const I = it.icon;
          return (
            <button
              key={it.name}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => go({ name: it.name } as never)}
              className={cx('flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.72rem]', active ? 'text-accent' : 'text-muted')}
            >
              <span className={cx('flex h-7 w-14 items-center justify-center rounded-full transition-colors', active && 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]')}>
                <I size={21} strokeWidth={active ? 2.3 : 1.8} />
              </span>
              {it.label}
            </button>
          );
        })}
        <button ref={more.ref} type="button" onClick={more.toggle} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.72rem] text-muted" aria-label="More">
          <span className="flex h-7 w-14 items-center justify-center">
            <Ellipsis size={21} />
          </span>
          More
        </button>
      </div>
      <Popover anchor={more.ref} open={more.open} onClose={more.hide} label="More" width={240}>
        <div role="menu" className="py-1">
          <MenuItem icon={<CalendarDays size={17} />} onClick={() => (more.hide(), go({ name: 'calendar' }))}>Calendar</MenuItem>
          <MenuItem icon={<Target size={17} />} onClick={() => (more.hide(), go({ name: 'focus' }))}>Focus mode</MenuItem>
          <MenuItem icon={<BarChart3 size={17} />} onClick={() => (more.hide(), go({ name: 'insights' }))}>Insights</MenuItem>
          <MenuItem icon={<Filter size={17} />} onClick={() => (more.hide(), go({ name: 'filters' }))}>Filters</MenuItem>
          <MenuItem icon={<Tag size={17} />} onClick={() => (more.hide(), go({ name: 'labels' }))}>Labels</MenuItem>
          <MenuItem icon={<Workflow size={17} />} onClick={() => (more.hide(), go({ name: 'automations' }))}>Automations</MenuItem>
          <MenuItem icon={<Search size={17} />} onClick={() => (more.hide(), go({ name: 'search', q: '' }))}>Search</MenuItem>
          <MenuItem icon={<Trash2 size={17} />} onClick={() => (more.hide(), go({ name: 'trash' }))}>Trash</MenuItem>
          <MenuItem icon={<Settings size={17} />} onClick={() => (more.hide(), go({ name: 'settings' }))}>Settings</MenuItem>
          <div className="flex items-center gap-2 px-3 py-2 text-[0.8rem] text-subtle">
            <SaveIndicator compact /> Data is stored on this device
          </div>
        </div>
      </Popover>
    </nav>
  );
}

export function QuickAddFab() {
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const loc = useLocation();
  const today = useToday();
  const r = loc.route;
  return (
    <button
      type="button"
      aria-label="Add task"
      onClick={() => openQuickAdd(quickAddDefaultsFor(r, today))}
      className="mb-safe fixed right-4 bottom-20 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-fg shadow-pop active:scale-95"
    >
      <Plus size={26} strokeWidth={2.4} />
    </button>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const isDesktop = useIsDesktop();
  return (
    <div
      aria-live="polite"
      className={cx('pointer-events-none fixed z-[80] flex flex-col gap-2', isDesktop ? 'bottom-5 left-1/2 -translate-x-1/2' : 'inset-x-3 bottom-24 mb-safe')}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cx(
            'anim-pop pointer-events-auto flex min-w-[280px] max-w-[520px] items-center gap-3 rounded-xl px-4 py-2.5 text-[0.9rem] shadow-pop',
            t.tone === 'error' ? 'bg-danger text-white' : 'bg-fg text-bg',
          )}
        >
          {t.tone === 'success' && <CircleCheck size={16} className="shrink-0 opacity-80" />}
          <span className="min-w-0 flex-1">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 font-semibold text-[color-mix(in_srgb,var(--accent)_60%,var(--bg))] hover:underline"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 opacity-60 hover:opacity-100">
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Bulk actions for the current multi-selection. */
export function SelectionBar() {
  const app = useApp();
  const act = useAction();
  const selection = useUi((s) => s.selection);
  const clear = useUi((s) => s.clearSelection);
  const date = usePopover();
  const prio = usePopover();
  const move = usePopover();
  const loc = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clear();
  }, [loc.route, clear]);
  if (!selection.length) return null;
  const run = (fn: (force: boolean) => unknown) => {
    act(fn);
    clear();
  };
  return (
    <div className="anim-pop fixed inset-x-3 bottom-24 z-40 mx-auto flex max-w-xl items-center gap-1 rounded-2xl border border-line bg-surface px-2 py-1.5 shadow-pop lg:bottom-6" role="toolbar" aria-label="Selected tasks">
      <span className="px-2 text-[0.88rem] font-medium">{selection.length} selected</span>
      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Complete selected" onClick={() => run((force) => app.tasks.bulkComplete(selection, { force }))}>
          <Check size={17} />
        </IconButton>
        <IconButton ref={date.ref} label="Schedule selected" onClick={date.toggle}>
          <CalendarDays size={17} />
        </IconButton>
        <IconButton ref={prio.ref} label="Set priority" onClick={prio.toggle}>
          <Flag size={17} />
        </IconButton>
        <IconButton ref={move.ref} label="Move selected" onClick={move.toggle}>
          <FolderInput size={17} />
        </IconButton>
        <IconButton label="Delete selected" onClick={() => run(() => app.tasks.remove(selection))}>
          <Trash2 size={17} />
        </IconButton>
        <IconButton label="Clear selection (Esc)" onClick={clear}>
          <X size={17} />
        </IconButton>
      </div>
      <DatePopover anchor={date.ref} open={date.open} onClose={date.hide} value={null} onChange={(d) => run((force) => app.tasks.bulkUpdate(selection, { scheduledDate: d }, { force }))} />
      <PriorityPopover anchor={prio.ref} open={prio.open} onClose={prio.hide} value={4} onChange={(p) => run(() => app.tasks.bulkUpdate(selection, { priority: p }))} />
      <ProjectPopover anchor={move.ref} open={move.open} onClose={move.hide} value={{ projectId: null }} onChange={(v) => run(() => app.tasks.move(selection, v))} />
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Q or N', 'Quick Add'],
  ['/', 'Search'],
  ['G then I / T / U / C / P / L', 'Go to Inbox, Today, Upcoming, Calendar, Projects, Labels'],
  ['G then F', 'Focus mode'],
  ['G then V', 'Filters'],
  ['G then A', 'Automations'],
  ['G then N', 'Insights'],
  ['G then S', 'Settings'],
  ['↑ ↓ or J K', 'Move between tasks'],
  ['Enter', 'Open task'],
  ['E', 'Complete focused task'],
  ['1 – 4', 'Set priority of focused task'],
  ['X', 'Select focused task'],
  ['Ctrl/⌘ + click, Shift + click', 'Multi-select'],
  ['Delete', 'Delete focused task (undoable)'],
  ['[', 'Toggle sidebar'],
  ['Esc', 'Close panel or clear selection'],
  ['?', 'This list'],
];

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-[0.9rem]">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <Kbd>{k}</Kbd>
            </dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

export function useGlobalShortcuts() {
  const [, setPending] = useState(false);
  const pendingG = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUi.getState();
      const k = e.key.toLowerCase();
      if (pendingG.current) {
        pendingG.current = false;
        setPending(false);
        const map: Record<string, Parameters<typeof go>[0]> = {
          i: { name: 'inbox' }, t: { name: 'today' }, u: { name: 'upcoming' }, c: { name: 'calendar' }, p: { name: 'projects' },
          l: { name: 'labels' }, f: { name: 'focus' }, s: { name: 'settings' }, v: { name: 'filters' }, a: { name: 'automations' }, n: { name: 'insights' },
        };
        if (map[k]) {
          e.preventDefault();
          go(map[k]);
        }
        return;
      }
      if (k === 'q' || k === 'n') {
        e.preventDefault();
        const hash = window.location.hash;
        const route = parseHash(hash).route;
        ui.openQuickAdd(quickAddDefaultsFor(route, todayISO()));
      } else if (k === '/') {
        e.preventDefault();
        go({ name: 'search', q: '' });
      } else if (k === 'g') {
        pendingG.current = true;
        setPending(true);
        setTimeout(() => (pendingG.current = false), 1200);
      } else if (e.key === '?') {
        ui.setShortcutsOpen(true);
      } else if (k === '[') {
        ui.toggleSidebar();
      } else if (k === 'escape' && ui.selection.length) {
        ui.clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Global prompt shown when an action needs confirmation (e.g. completing a blocked task). */
export function GlobalConfirm() {
  const c = useUi((s) => s.confirm);
  const close = useUi((s) => s.closeConfirm);
  return (
    <ConfirmDialog
      open={!!c}
      onClose={close}
      title="Are you sure?"
      body={c?.message ?? ''}
      confirmLabel={c?.confirmLabel ?? 'Continue'}
      onConfirm={() => c?.onConfirm()}
    />
  );
}
