import { useDeferredValue, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { isOpenStatus } from '@/core/domain/types';
import { useApp, useQuery } from '../hooks';
import { go, navigate } from '../router';
import { EmptyState, Input, Switch } from '../primitives';
import { GroupHeading, ViewBody } from '../components/common';
import { OrganisedTaskList, ViewOptionsButton } from '../components/ViewOptions';
import { ProjectIcon, readableColor } from '../components/meta';
import { ViewHeader } from '../layout/Chrome';

export function SearchView({ q }: { q: string }) {
  const app = useApp();
  const [text, setText] = useState(q);
  const [includeDone, setIncludeDone] = useState(false);
  const deferred = useDeferredValue(text);
  useEffect(() => {
    const t = setTimeout(() => navigate(deferred ? `/search?q=${encodeURIComponent(deferred)}` : '/search', { replace: true }), 300);
    return () => clearTimeout(t);
  }, [deferred]);
  const results = useQuery(() => (deferred.trim() ? app.repos.tasks.search(deferred) : []), [deferred]);
  const projects = useQuery(
    () => (deferred.trim() ? app.repos.projects.list({ includeArchived: true }).filter((p) => p.name.toLowerCase().includes(deferred.trim().toLowerCase())) : []),
    [deferred],
  );
  const labels = useQuery(
    () => (deferred.trim() ? app.repos.labels.list().filter((l) => l.name.toLowerCase().includes(deferred.trim().toLowerCase().replace(/^@/, ''))) : []),
    [deferred],
  );
  const shown = includeDone ? results : results.filter((t) => isOpenStatus(t.status));
  return (
    <>
      <ViewHeader title="Search" icon={<Search size={22} className="text-muted" />} actions={<ViewOptionsButton viewId="search" />} />
      <ViewBody>
        <div className="-mx-1 bg-bg px-1 pb-2 pt-3 lg:sticky lg:top-0 lg:z-10">
          <Input
            autoFocus
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search tasks, notes, projects, labels"
            aria-label="Search"
            enterKeyHint="search"
            className="h-11 text-[1rem]"
          />
          <label className="mt-2 flex items-center gap-2 text-[0.85rem] text-muted">
            <Switch checked={includeDone} onChange={setIncludeDone} label="Include completed tasks" /> Include completed
          </label>
        </div>
        {(projects.length > 0 || labels.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {projects.map((p) => (
              <button key={p.id} type="button" onClick={() => go({ name: 'project', id: p.id })} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[0.85rem] hover:bg-surface-2">
                <ProjectIcon icon={p.icon} color={p.color} size={14} /> {p.name}
              </button>
            ))}
            {labels.map((l) => (
              <button key={l.id} type="button" onClick={() => go({ name: 'label', id: l.id })} className="rounded-lg border border-line px-2.5 py-1 text-[0.85rem] hover:bg-surface-2" style={{ color: readableColor(l.color) }}>
                @{l.name}
              </button>
            ))}
          </div>
        )}
        {deferred.trim() ? (
          shown.length ? (
            <GroupHeading title="Tasks" count={shown.length}>
              <OrganisedTaskList viewId="search" tasks={shown} tree={false} showProject ariaLabel="Search results" />
            </GroupHeading>
          ) : (
            <EmptyState icon={<Search size={26} />} title="No matching tasks" body={results.length ? 'Only completed tasks match — switch on “Include completed”.' : 'Try fewer or different words. Search matches the start of words.'} />
          )
        ) : (
          <EmptyState icon={<Search size={26} />} title="Search everything" body="Search runs on this device and works offline." />
        )}
      </ViewBody>
    </>
  );
}
