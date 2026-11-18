import { useMemo, useState } from 'react';
import { Link2, Lock, Plus, X } from 'lucide-react';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { useAction, useApp, useQuery } from '../hooks';
import { openTask } from '../router';
import { Button, IconButton, Input, MenuItem, Popover, cx } from '../primitives';
import { usePopover } from './pickers';
import { Section } from './TaskDetail';

function TaskRef({ task, onRemove }: { task: Task; onRemove: () => void }) {
  const done = !isOpenStatus(task.status);
  return (
    <li className="flex items-center gap-2 py-1 text-[0.9rem]">
      <span className={cx('h-2 w-2 shrink-0 rounded-full', done ? 'bg-ok' : 'bg-warn')} aria-hidden />
      <button type="button" onClick={() => openTask(task.id)} className={cx('min-w-0 flex-1 truncate text-left hover:underline', done && 'text-muted line-through')}>
        {task.title}
      </button>
      <span className="text-[0.75rem] text-subtle">{done ? 'done' : 'open'}</span>
      <IconButton size="sm" label={`Remove link to ${task.title}`} onClick={onRemove}>
        <X size={13} />
      </IconButton>
    </li>
  );
}

/** "Waiting on" (prerequisites) and "Blocks" (dependants), with a task picker. Spec 4.4. */
export function DependenciesSection({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const prereqs = useQuery(() => app.repos.tasks.getMany(app.repos.dependencies.prerequisitesOf(task.id)), [task.id]);
  const dependants = useQuery(() => app.repos.tasks.getMany(app.repos.dependencies.dependentsOf(task.id)), [task.id]);
  const picker = usePopover();
  const [q, setQ] = useState('');
  const exclude = useMemo(() => new Set([task.id, ...prereqs.map((p) => p.id)]), [task.id, prereqs]);
  const results = useQuery(
    () => (q.trim() ? app.repos.tasks.search(q, 30) : (task.projectId ? app.repos.tasks.listByProject(task.projectId) : app.repos.tasks.listInbox()).slice(0, 30)).filter((t) => !exclude.has(t.id) && isOpenStatus(t.status)),
    [q, exclude, task.projectId],
  );
  const openBlockers = prereqs.filter((p) => isOpenStatus(p.status)).length;

  return (
    <Section
      icon={<Link2 size={15} />}
      title="Dependencies"
      count={prereqs.length + dependants.length || undefined}
      defaultOpen={prereqs.length + dependants.length > 0}
      action={
        <>
          <Button size="sm" variant="ghost" ref={picker.ref} onClick={picker.toggle}>
            <Plus size={14} /> Waiting on…
          </Button>
          {/* Outside the collapsible body so it works while the section is collapsed. */}
          <Popover anchor={picker.ref} open={picker.open} onClose={picker.hide} label="Choose a task this one waits on" width={320}>
            <div className="p-2">
              <Input autoFocus placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
            </div>
            <div role="menu" className="max-h-72 overflow-y-auto pb-1">
              {results.map((t) => (
                <MenuItem
                  key={t.id}
                  onClick={() => {
                    picker.hide();
                    setQ('');
                    act(() => app.tasks.addDependency(task.id, t.id));
                  }}
                >
                  {t.title}
                </MenuItem>
              ))}
              {results.length === 0 && <p className="px-3 py-2 text-[0.85rem] text-muted">{q ? 'No matching open tasks' : 'No other open tasks here — type to search everything'}</p>}
            </div>
          </Popover>
        </>
      }
    >
      {openBlockers > 0 && (
        <p className="mb-1 flex items-center gap-1.5 text-[0.82rem] text-warn">
          <Lock size={13} /> Blocked by {openBlockers} unfinished task{openBlockers > 1 ? 's' : ''}
        </p>
      )}
      {prereqs.length > 0 && (
        <>
          <h3 className="text-[0.78rem] font-medium text-muted">Waiting on</h3>
          <ul>{prereqs.map((p) => <TaskRef key={p.id} task={p} onRemove={() => act(() => app.tasks.removeDependency(task.id, p.id))} />)}</ul>
        </>
      )}
      {dependants.length > 0 && (
        <>
          <h3 className="mt-2 text-[0.78rem] font-medium text-muted">Blocks</h3>
          <ul>{dependants.map((d) => <TaskRef key={d.id} task={d} onRemove={() => act(() => app.tasks.removeDependency(d.id, task.id))} />)}</ul>
        </>
      )}
      {prereqs.length + dependants.length === 0 && <p className="text-[0.85rem] text-subtle">This task doesn’t depend on anything.</p>}
    </Section>
  );
}
