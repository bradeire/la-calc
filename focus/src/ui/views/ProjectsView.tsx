import { useState } from 'react';
import { ArchiveRestore, FolderKanban, Plus, Star } from 'lucide-react';
import { useAction, useApp, useQuery } from '../hooks';
import { go } from '../router';
import { Button, EmptyState, IconButton } from '../primitives';
import { GroupHeading, ViewBody } from '../components/common';
import { ProjectDialog } from '../components/ProjectDialog';
import { ProjectIcon } from '../components/meta';
import { orderProjects } from '../components/pickers';
import { ViewHeader } from '../layout/Chrome';

export function ProjectsView() {
  const app = useApp();
  const act = useAction();
  const projects = useQuery(() => orderProjects(app.repos.projects.list()), []);
  const archived = useQuery(() => app.repos.projects.listArchived(), []);
  const stats = useQuery(() => app.repos.projects.stats(), []);
  const [creating, setCreating] = useState(false);
  const depth = (id: string | null, n = 0): number => {
    const p = projects.find((x) => x.id === id);
    return p?.parentId && n < 10 ? depth(p.parentId, n + 1) : n;
  };
  return (
    <>
      <ViewHeader
        title="Projects"
        icon={<FolderKanban size={22} className="text-accent" />}
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} /> New
          </Button>
        }
      />
      <ViewBody>
        {projects.length === 0 && (
          <EmptyState
            icon={<FolderKanban size={26} />}
            title="No projects yet"
            body="Projects group related tasks. They can be nested, split into sections and shown as a list, board, table or calendar."
            action={<Button variant="primary" onClick={() => setCreating(true)}>Create a project</Button>}
          />
        )}
        <ul className="flex flex-col">
          {projects.map((p) => {
            const s = stats.get(p.id);
            const total = (s?.open ?? 0) + (s?.completed ?? 0);
            const pct = total ? Math.round(((s?.completed ?? 0) / total) * 100) : 0;
            return (
              <li key={p.id} className="border-b border-line">
                <button type="button" onClick={() => go({ name: 'project', id: p.id })} className="flex w-full items-center gap-3 py-3 text-left hover:bg-surface-2/50" style={{ paddingLeft: depth(p.id) * 20 + 4 }}>
                  <ProjectIcon icon={p.icon} color={p.color} size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate font-medium">
                      {p.name} {p.isFavorite && <Star size={12} className="text-warn" fill="currentColor" aria-label="Favourite" />}
                    </span>
                    {p.description && <span className="block truncate text-[0.82rem] text-muted">{p.description}</span>}
                  </span>
                  <span className="flex w-36 shrink-0 items-center gap-2 text-[0.78rem] text-muted">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} progress`}>
                      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: p.color }} />
                    </span>
                    {s?.open ?? 0} open
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {archived.length > 0 && (
          <GroupHeading title="Archived" count={archived.length} collapsible defaultOpen={false}>
            <ul>
              {archived.map((p) => (
                <li key={p.id} className="flex items-center gap-3 border-b border-line py-2.5 pl-1">
                  <ProjectIcon icon={p.icon} color={p.color} />
                  <button type="button" className="flex-1 truncate text-left text-muted hover:text-fg" onClick={() => go({ name: 'project', id: p.id })}>
                    {p.name}
                  </button>
                  <IconButton label={`Unarchive ${p.name}`} onClick={() => act(() => app.projects.unarchive(p.id))}>
                    <ArchiveRestore size={16} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </GroupHeading>
        )}
      </ViewBody>
      <ProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
