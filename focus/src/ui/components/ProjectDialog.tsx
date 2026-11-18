import { useEffect, useState } from 'react';
import { PALETTE, PROJECT_LAYOUTS, type Project, type ProjectLayout } from '@/core/domain/types';
import { errorMessage, useApp, useQuery } from '../hooks';
import { go } from '../router';
import { Button, Dialog, Field, Input, Select, Switch, Textarea, cx } from '../primitives';
import { PROJECT_ICONS, ProjectIcon } from './meta';
import { orderProjects } from './pickers';

const LAYOUT_NAMES: Record<ProjectLayout, string> = { list: 'List', board: 'Board', table: 'Table', calendar: 'Calendar' };

/** Create or edit a project. */
export function ProjectDialog({ open, onClose, project, parentId }: { open: boolean; onClose: () => void; project?: Project; parentId?: string | null }) {
  const app = useApp();
  const projects = useQuery(() => orderProjects(app.repos.projects.list()), []);
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[7]!.value);
  const [icon, setIcon] = useState('folder');
  const [parent, setParent] = useState<string | null>(null);
  const [layout, setLayout] = useState<ProjectLayout>('list');
  const [fav, setFav] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setColor(project?.color ?? PALETTE[(projects.length + 7) % PALETTE.length]!.value);
    setIcon(project?.icon ?? 'folder');
    setParent(project ? project.parentId : (parentId ?? null));
    setLayout(project?.layout ?? 'list');
    setFav(project?.isFavorite ?? false);
    setDescription(project?.description ?? '');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project, parentId]);

  const save = () => {
    try {
      const input = { name, color, icon, parentId: parent, layout, isFavorite: fav, description };
      if (project) app.projects.update(project.id, input);
      else go({ name: 'project', id: app.projects.create(input).id });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            {project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name" htmlFor="project-name">
          <Input id="project-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
            {PALETTE.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                aria-label={c.name}
                onClick={() => setColor(c.value)}
                className={cx('h-7 w-7 rounded-full border-2', color === c.value ? 'border-fg' : 'border-transparent')}
                style={{ background: c.value }}
              />
            ))}
          </div>
        </Field>
        <Field label="Icon">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Icon">
            {Object.keys(PROJECT_ICONS).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={icon === k}
                aria-label={k}
                onClick={() => setIcon(k)}
                className={cx('flex h-9 w-9 items-center justify-center rounded-lg border', icon === k ? 'border-accent bg-surface-2' : 'border-transparent hover:bg-surface-2')}
              >
                <ProjectIcon icon={k} color={color} size={17} />
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Parent project" htmlFor="project-parent">
            <Select id="project-parent" value={parent ?? ''} onChange={(e) => setParent(e.target.value || null)}>
              <option value="">None (top level)</option>
              {projects
                .filter((p) => p.id !== project?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Default layout" htmlFor="project-layout">
            <Select id="project-layout" value={layout} onChange={(e) => setLayout(e.target.value as ProjectLayout)}>
              {PROJECT_LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {LAYOUT_NAMES[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description" htmlFor="project-desc">
          <Textarea id="project-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="flex items-center justify-between gap-3 text-[0.92rem]">
          Add to favourites
          <Switch checked={fav} onChange={setFav} label="Add to favourites" />
        </label>
        {error && (
          <p role="alert" className="text-[0.85rem] text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
