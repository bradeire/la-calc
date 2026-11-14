import { useState } from 'react';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { PALETTE, type Label } from '@/core/domain/types';
import { errorMessage, useAction, useApp, useQuery } from '../hooks';
import { go } from '../router';
import { Button, Dialog, EmptyState, Field, IconButton, Input, cx } from '../primitives';
import { AddTaskRow, ViewBody } from '../components/common';
import { TaskList } from '../components/TaskList';
import { ViewHeader } from '../layout/Chrome';

function LabelDialog({ open, onClose, label }: { open: boolean; onClose: () => void; label?: Label }) {
  const app = useApp();
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState(label?.color ?? PALETTE[6]!.value);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      if (label) app.labels.update(label.id, { name, color });
      else app.labels.create({ name, color });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={label ? 'Edit label' : 'New label'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4 p-4" onSubmit={(e) => (e.preventDefault(), save())}>
        <Field label="Name" htmlFor="label-name" hint="One word; use - or _ to join words.">
          <Input id="label-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
            {PALETTE.map((c) => (
              <button key={c.value} type="button" role="radio" aria-checked={color === c.value} aria-label={c.name} onClick={() => setColor(c.value)} className={cx('h-7 w-7 rounded-full border-2', color === c.value ? 'border-fg' : 'border-transparent')} style={{ background: c.value }} />
            ))}
          </div>
        </Field>
        {error && <p role="alert" className="text-[0.85rem] text-danger">{error}</p>}
      </form>
    </Dialog>
  );
}

export function LabelsView() {
  const app = useApp();
  const act = useAction();
  const labels = useQuery(() => app.repos.labels.list(), []);
  const counts = useQuery(() => app.repos.labels.counts(), []);
  const [editing, setEditing] = useState<Label | 'new' | null>(null);
  return (
    <>
      <ViewHeader
        title="Labels"
        icon={<Tag size={22} className="text-muted" />}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            <Plus size={15} /> New
          </Button>
        }
      />
      <ViewBody>
        {labels.length === 0 ? (
          <EmptyState icon={<Tag size={26} />} title="No labels yet" body="Labels cut across projects — for example @calls, @errands or @waiting-on. Type @name in Quick Add to create one." />
        ) : (
          <ul>
            {labels.map((l) => (
              <li key={l.id} className="group flex items-center gap-3 border-b border-line py-1.5">
                <button type="button" onClick={() => go({ name: 'label', id: l.id })} className="flex flex-1 items-center gap-3 py-1.5 text-left">
                  <Tag size={16} style={{ color: l.color }} aria-hidden />
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="text-[0.8rem] text-subtle">{counts.get(l.id) ?? 0}</span>
                </button>
                <IconButton size="sm" label={`Edit ${l.name}`} onClick={() => setEditing(l)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton size="sm" label={`Delete ${l.name}`} onClick={() => act(() => app.labels.remove(l.id))}>
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </ViewBody>
      {editing && <LabelDialog open onClose={() => setEditing(null)} label={editing === 'new' ? undefined : editing} />}
    </>
  );
}

export function LabelView({ id }: { id: string }) {
  const app = useApp();
  const label = useQuery(() => app.repos.labels.get(id), [id]);
  const tasks = useQuery(() => app.repos.tasks.listByLabel(id), [id]);
  if (!label || label.deletedAt) return <EmptyState icon={<Tag size={26} />} title="Label not found" action={<Button onClick={() => go({ name: 'labels' })}>All labels</Button>} />;
  return (
    <>
      <ViewHeader title={label.name} icon={<Tag size={22} style={{ color: label.color }} />} subtitle={`${tasks.length} open task${tasks.length === 1 ? '' : 's'}`} />
      <ViewBody>
        <TaskList tasks={tasks} tree={false} showProject draggable ariaLabel={`Tasks labelled ${label.name}`} />
        <AddTaskRow defaults={{ labelIds: [id] }} />
        {tasks.length === 0 && <EmptyState icon={<Tag size={26} />} title={`Nothing labelled ${label.name}`} />}
      </ViewBody>
    </>
  );
}
