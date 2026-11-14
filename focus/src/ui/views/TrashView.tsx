import { useState } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useAction, useApp, useQuery } from '../hooks';
import { Button, ConfirmDialog, EmptyState, IconButton } from '../primitives';
import { GroupHeading, ViewBody } from '../components/common';
import { ProjectIcon } from '../components/meta';
import { ViewHeader } from '../layout/Chrome';
import { useUi } from '@/state/ui-store';

export function TrashView() {
  const app = useApp();
  const act = useAction();
  const pushToast = useUi((s) => s.pushToast);
  const tasks = useQuery(() => app.repos.tasks.listTrash(), []);
  const projects = useQuery(() => app.repos.projects.listTrash(), []);
  const labels = useQuery(() => app.repos.labels.listTrash(), []);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [purge, setPurge] = useState<{ kind: 'task' | 'project' | 'label'; id: string; name: string } | null>(null);
  const empty = tasks.length + projects.length + labels.length === 0;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
  return (
    <>
      <ViewHeader
        title="Trash"
        icon={<Trash2 size={22} className="text-muted" />}
        subtitle="Deleted items stay here until you empty Trash"
        actions={!empty && <Button size="sm" variant="ghost" onClick={() => setConfirmEmpty(true)}>Empty Trash</Button>}
      />
      <ViewBody>
        {empty && <EmptyState icon={<Trash2 size={26} />} title="Trash is empty" />}
        {projects.length > 0 && (
          <GroupHeading title="Projects" count={projects.length}>
            <ul>
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 border-b border-line py-2">
                  <ProjectIcon icon={p.icon} color={p.color} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-[0.78rem] text-subtle">{when(p.deletedAt)}</span>
                  <IconButton label={`Restore ${p.name}`} onClick={() => act(() => app.projects.restore(p.id), { success: 'Project restored with its tasks' })}><RotateCcw size={16} /></IconButton>
                  <IconButton label={`Delete ${p.name} permanently`} onClick={() => setPurge({ kind: 'project', id: p.id, name: p.name })}><X size={16} /></IconButton>
                </li>
              ))}
            </ul>
          </GroupHeading>
        )}
        {tasks.length > 0 && (
          <GroupHeading title="Tasks" count={tasks.length}>
            <ul>
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 border-b border-line py-2">
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="text-[0.78rem] text-subtle">{when(t.deletedAt)}</span>
                  <IconButton label={`Restore ${t.title}`} onClick={() => act(() => app.tasks.restore(t.id), { success: 'Task restored' })}><RotateCcw size={16} /></IconButton>
                  <IconButton label={`Delete ${t.title} permanently`} onClick={() => setPurge({ kind: 'task', id: t.id, name: t.title })}><X size={16} /></IconButton>
                </li>
              ))}
            </ul>
          </GroupHeading>
        )}
        {labels.length > 0 && (
          <GroupHeading title="Labels" count={labels.length}>
            <ul>
              {labels.map((l) => (
                <li key={l.id} className="flex items-center gap-3 border-b border-line py-2">
                  <span className="flex-1 truncate" style={{ color: l.color }}>@{l.name}</span>
                  <IconButton label={`Restore ${l.name}`} onClick={() => act(() => app.labels.restore(l.id), { success: 'Label restored' })}><RotateCcw size={16} /></IconButton>
                  <IconButton label={`Delete ${l.name} permanently`} onClick={() => setPurge({ kind: 'label', id: l.id, name: l.name })}><X size={16} /></IconButton>
                </li>
              ))}
            </ul>
          </GroupHeading>
        )}
      </ViewBody>
      <ConfirmDialog
        open={confirmEmpty}
        onClose={() => setConfirmEmpty(false)}
        title="Empty Trash?"
        body="Everything in Trash, including attached files, will be permanently deleted. This cannot be undone."
        confirmLabel="Delete permanently"
        danger
        onConfirm={() => {
          app.data
            .emptyTrash()
            .then((n) => pushToast({ message: `Trash emptied (${n} task${n === 1 ? '' : 's'})`, tone: 'success' }))
            .catch((err: unknown) => pushToast({ message: String(err), tone: 'error' }));
        }}
      />
      <ConfirmDialog
        open={!!purge}
        onClose={() => setPurge(null)}
        title={`Delete “${purge?.name}” permanently?`}
        body="This cannot be undone."
        confirmLabel="Delete permanently"
        danger
        onConfirm={() => {
          if (!purge) return;
          if (purge.kind === 'task') act(() => app.tasks.purge(purge.id));
          else if (purge.kind === 'project') act(() => app.projects.purge(purge.id));
          else act(() => app.repos.labels.hardDelete(purge.id));
        }}
      />
    </>
  );
}
