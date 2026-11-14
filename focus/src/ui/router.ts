import { useSyncExternalStore } from 'react';

/** Hash router (ADR-007). Every navigation is a history entry so Android "back" works. */
export type Route =
  | { name: 'today' }
  | { name: 'inbox' }
  | { name: 'upcoming' }
  | { name: 'calendar' }
  | { name: 'focus' }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'labels' }
  | { name: 'label'; id: string }
  | { name: 'search'; q: string }
  | { name: 'settings' }
  | { name: 'trash' }
  | { name: 'notfound' };

export interface Location {
  route: Route;
  /** Open task-detail id (?task=…) */
  taskId: string | null;
  raw: string;
}

export function parseHash(hash: string): Location {
  const h = hash.replace(/^#/, '') || '/today';
  const [path = '/today', query = ''] = h.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  let route: Route;
  switch (parts[0]) {
    case undefined:
    case 'today': route = { name: 'today' }; break;
    case 'inbox': route = { name: 'inbox' }; break;
    case 'upcoming': route = { name: 'upcoming' }; break;
    case 'calendar': route = { name: 'calendar' }; break;
    case 'focus': route = { name: 'focus' }; break;
    case 'projects': route = { name: 'projects' }; break;
    case 'project': route = parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' }; break;
    case 'labels': route = { name: 'labels' }; break;
    case 'label': route = parts[1] ? { name: 'label', id: parts[1] } : { name: 'labels' }; break;
    case 'search': route = { name: 'search', q: params.get('q') ?? '' }; break;
    case 'settings': route = { name: 'settings' }; break;
    case 'trash': route = { name: 'trash' }; break;
    default: route = { name: 'notfound' };
  }
  return { route, taskId: params.get('task'), raw: h };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'project': return `/project/${r.id}`;
    case 'label': return `/label/${r.id}`;
    case 'search': return r.q ? `/search?q=${encodeURIComponent(r.q)}` : '/search';
    case 'notfound': return '/today';
    default: return `/${r.name}`;
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

let cached: { hash: string; loc: Location } | null = null;
function snapshot(): Location {
  const hash = window.location.hash;
  if (!cached || cached.hash !== hash) cached = { hash, loc: parseHash(hash) };
  return cached.loc;
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) return;
  if (opts.replace) {
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else window.location.hash = path;
}

export function go(r: Route) {
  navigate(routePath(r));
}

/** Open a task in the detail panel; pushes a history entry so Back closes it. */
export function openTask(id: string) {
  const loc = snapshot();
  const base = loc.raw.split('?')[0];
  const params = new URLSearchParams(loc.raw.split('?')[1] ?? '');
  if (params.get('task') === id) return;
  const replacing = params.has('task');
  params.set('task', id);
  navigate(`${base}?${params}`, { replace: replacing });
}

export function closeTask() {
  const loc = snapshot();
  if (!loc.taskId) return;
  const base = loc.raw.split('?')[0]!;
  const params = new URLSearchParams(loc.raw.split('?')[1] ?? '');
  params.delete('task');
  const q = params.toString();
  navigate(q ? `${base}?${q}` : base, { replace: true });
}

/** Quick Add defaults implied by the current view, shared by every entry point (FAB, sidebar, keyboard). */
export function quickAddDefaultsFor(route: Route, today: string): { projectId?: string; scheduledDate?: string; labelIds?: string[] } {
  if (route.name === 'project') return { projectId: route.id };
  if (route.name === 'today') return { scheduledDate: today };
  if (route.name === 'label') return { labelIds: [route.id] };
  return {};
}
