import { useState } from 'react';
import { LayoutTemplate, Trash2 } from 'lucide-react';
import { useAction, useApp, useQuery, useToday } from '../hooks';
import { go } from '../router';
import { Button, Dialog, Field, IconButton, Input, cx } from '../primitives';
import { TemplateFromWords } from './AiFeatures';

/** Create a project from a built-in or saved template (spec 4.7). */
export function TemplateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const templates = useQuery(() => app.templates.list(), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState(today);
  const pick = templates.find((t) => t.id === chosen);
  const create = () => {
    const p = act(() => app.templates.instantiate(chosen!, { name: name.trim() || pick!.name, startDate: start }));
    if (p) {
      onClose();
      setChosen(null);
      go({ name: 'project', id: p.id });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project from a template"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen || !start} onClick={create}>
            Create project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <ul className="flex flex-col gap-1.5" role="radiogroup" aria-label="Templates">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={chosen === t.id}
                onClick={() => {
                  setChosen(t.id);
                  setName(t.name);
                }}
                className={cx('flex flex-1 items-start gap-3 rounded-lg border p-3 text-left', chosen === t.id ? 'border-accent bg-surface-2' : 'border-line hover:bg-surface-2')}
              >
                <LayoutTemplate size={18} className="mt-0.5 text-accent" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {t.name} {t.builtIn && <span className="ml-1 rounded bg-surface-3 px-1.5 py-px text-[0.72rem] font-normal text-muted">Built-in</span>}
                  </span>
                  <span className="block text-[0.82rem] text-muted">{t.description || `${t.taskCount} tasks`}</span>
                </span>
              </button>
              {!t.builtIn && (
                <IconButton label={`Delete template ${t.name}`} onClick={() => act(() => app.templates.remove(t.id))}>
                  <Trash2 size={15} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        {chosen && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name" htmlFor="tpl-name">
              <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Start date" htmlFor="tpl-start" hint="Template dates are counted from this day.">
              <Input id="tpl-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </div>
        )}
        <TemplateFromWords onCreated={onClose} />
        <p className="text-[0.8rem] text-subtle">Save any project as a template from its ⋯ menu.</p>
      </div>
    </Dialog>
  );
}
