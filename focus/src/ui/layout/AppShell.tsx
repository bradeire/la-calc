import { useEffect, useRef } from 'react';
import { useUi } from '@/state/ui-store';
import { useApp, useIsDesktop, useSettings } from '../hooks';
import { parseIncomingLink } from '@/core/links';
import { closeTask, navigate, useLocation } from '../router';
import { cx } from '../primitives';
import { QuickAdd } from '../components/QuickAdd';
import { CaptureDialog } from '../components/CaptureDialog';
import { ReminderPanel, useReminderDelivery } from '../components/ReminderPanel';
import { TaskDetail } from '../components/TaskDetail';
import { BottomNav, GlobalConfirm, QuickAddFab, SelectionBar, ShortcutsDialog, Toasts, useGlobalShortcuts } from './Chrome';
import { Sidebar } from './Sidebar';
import { TodayView } from '../views/TodayView';
import { InboxView } from '../views/InboxView';
import { UpcomingView } from '../views/UpcomingView';
import { ProjectView } from '../views/ProjectView';
import { ProjectsView } from '../views/ProjectsView';
import { LabelsView, LabelView } from '../views/LabelsView';
import { SearchView } from '../views/SearchView';
import { TrashView } from '../views/TrashView';
import { FocusView } from '../views/FocusView';
import { CalendarView } from '../views/CalendarView';
import { SettingsView } from '../views/SettingsView';
import { FilterEditorView, FilterResultsView, FiltersView } from '../views/FiltersView';
import { AutomationEditorView, AutomationsView } from '../views/AutomationsView';
import { InsightsView } from '../views/InsightsView';
import { LongTimerPrompt, TimeLogView } from '../views/TimeLogView';
import { useAutomationRunner } from '../components/ReminderPanel';
import { Onboarding } from '../views/Onboarding';

function useApplyAppearance() {
  const s = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = s.theme === 'dark' || (s.theme === 'system' && mq.matches);
      root.classList.toggle('dark', dark);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#161615' : '#fbfbfa');
    };
    apply();
    mq.addEventListener('change', apply);
    root.style.setProperty('--accent', s.accent);
    root.style.setProperty('--font-scale', String(s.fontScale));
    root.classList.toggle('motion-off', s.reduceMotion === 'on');
    root.classList.toggle('motion-on', s.reduceMotion === 'off');
    return () => mq.removeEventListener('change', apply);
  }, [s.theme, s.accent, s.fontScale, s.reduceMotion]);
}

function ResizeHandle() {
  const setWidth = useUi((s) => s.setDetailWidth);
  const dragging = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details panel"
      aria-valuenow={useUi.getState().detailWidth}
      aria-valuemin={340}
      aria-valuemax={720}
      tabIndex={0}
      onKeyDown={(e) => {
        const w = useUi.getState().detailWidth;
        if (e.key === 'ArrowLeft') setWidth(w + 20);
        if (e.key === 'ArrowRight') setWidth(w - 20);
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => dragging.current && setWidth(window.innerWidth - e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      className="w-1 shrink-0 cursor-col-resize bg-line hover:bg-accent focus-visible:bg-accent"
    />
  );
}

function CurrentView() {
  const { route } = useLocation();
  switch (route.name) {
    case 'today': return <TodayView />;
    case 'inbox': return <InboxView />;
    case 'upcoming': return <UpcomingView />;
    case 'calendar': return <CalendarView />;
    case 'projects': return <ProjectsView />;
    case 'project': return <ProjectView id={route.id} />;
    case 'labels': return <LabelsView />;
    case 'label': return <LabelView id={route.id} />;
    case 'search': return <SearchView q={route.q} />;
    case 'trash': return <TrashView />;
    case 'filters': return <FiltersView />;
    case 'filter': return <FilterResultsView id={route.id} />;
    case 'filterEdit': return <FilterEditorView key={route.id ?? 'new'} id={route.id} />;
    case 'automations': return <AutomationsView />;
    case 'insights': return <InsightsView />;
    case 'timeLog': return <TimeLogView />;
    case 'automationEdit': return <AutomationEditorView key={route.id ?? 'new'} id={route.id} />;
    case 'settings': return <SettingsView />;
    case 'focus': return <FocusView />;
    default: return <TodayView />;
  }
}

export function AppShell() {
  const settings = useSettings();
  const isDesktop = useIsDesktop();
  const loc = useLocation();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const detailWidth = useUi((s) => s.detailWidth);
  useApplyAppearance();
  useGlobalShortcuts();
  useReminderDelivery();
  useAutomationRunner();

  // Esc closes the detail panel (dialogs handle their own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && loc.taskId && !(e.target as HTMLElement).closest('dialog[open], [role="dialog"]')) closeTask();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loc.taskId]);

  // App shortcut / share target: #/inbox?add=1 opens Quick Add.
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  useEffect(() => {
    const params = new URLSearchParams(loc.raw.split('?')[1] ?? '');
    if (params.get('capture') === '1' && settings.onboarded) {
      useUi.getState().openCapture();
      navigate(loc.raw.split('?')[0]!, { replace: true });
    }
    if (params.get('add') === '1' && settings.onboarded) {
      openQuickAdd({}, params.get('text') ?? undefined);
      navigate(loc.raw.split('?')[0]!, { replace: true });
    }
  }, [loc.raw, settings.onboarded, openQuickAdd]);

  // Android share sheet (installed PWA): text arrives as ?title=&text=&url= on the start URL.
  useEffect(() => {
    if (!settings.onboarded) return;
    const q = new URLSearchParams(window.location.search);
    const shared = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n').trim();
    if (!shared) return;
    history.replaceState(history.state, '', window.location.pathname + window.location.hash);
    if (shared.includes('\n') || shared.length > 200) useUi.getState().openCapture(shared);
    else openQuickAdd({}, shared);
  }, [settings.onboarded, openQuickAdd]);

  // Tap-to-add links (focus://add?text=…): pre-fill Quick Add or Capture; the user confirms.
  const app = useApp();
  const pendingLinks = useRef<string[]>([]);
  useEffect(() => {
    const open = (urls: string[]) => {
      const links = urls.map(parseIncomingLink).filter((l) => l !== null);
      if (!links.length) return;
      const ui = useUi.getState();
      if (links.length === 1 && links[0]!.kind === 'add') openQuickAdd({}, links[0]!.text);
      else {
        ui.closeQuickAdd();
        ui.openCapture(links.map((l) => l.text).join('\n'));
      }
    };
    const handle = (urls: string[]) => (settings.onboarded ? open(urls) : pendingLinks.current.push(...urls));
    if (settings.onboarded && pendingLinks.current.length) open(pendingLinks.current.splice(0));
    let alive = true;
    app.platform.links.initial().then((urls) => alive && urls.length && handle(urls));
    const stop = app.platform.links.listen(handle);
    return () => {
      alive = false;
      stop();
    };
  }, [app, settings.onboarded, openQuickAdd]);

  if (!settings.onboarded) return <Onboarding />;

  const isFocus = loc.route.name === 'focus';
  const detail = loc.taskId && !isFocus ? loc.taskId : null;

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {isDesktop && !collapsed && !isFocus && <Sidebar />}
      <main id="main" data-scroll-root className={cx('min-w-0 flex-1 overflow-y-auto scrollbar-thin', !isDesktop && !isFocus && 'pb-36')}>
        <CurrentView />
      </main>
      {detail && isDesktop && (
        <>
          <ResizeHandle />
          <aside aria-label="Task details" style={{ width: detailWidth }} className="shrink-0 overflow-hidden">
            <TaskDetail taskId={detail} variant="panel" />
          </aside>
        </>
      )}
      {detail && !isDesktop && (
        <div className="anim-sheet fixed inset-0 z-50 bg-surface" role="dialog" aria-modal="true" aria-label="Task details">
          <TaskDetail taskId={detail} variant="sheet" />
        </div>
      )}
      {!isDesktop && !isFocus && !detail && (
        <>
          <QuickAddFab />
          <BottomNav />
        </>
      )}
      <QuickAdd />
      <CaptureDialog />
      <SelectionBar />
      <ShortcutsDialog />
      <GlobalConfirm />
      <ReminderPanel />
      <LongTimerPrompt />
      <Toasts />
    </div>
  );
}

