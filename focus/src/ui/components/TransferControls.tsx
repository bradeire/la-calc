import { useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import type { ImportPreview } from '@/services/transfer-service';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useQuery } from '../hooks';
import { Button, Dialog, Field, Select, Switch } from '../primitives';
import { saveFile } from '../download';

type Pending = { kind: 'csv'; name: string; text: string; preview: ImportPreview } | { kind: 'project'; name: string; text: string; tasks: number; project: string | null };

/** CSV / Todoist / project-file import with a preview first, and CSV export (spec 6.6). */
export function TransferControls() {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const projects = useQuery(() => app.repos.projects.list(), []);
  const [project, setProject] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [pending, setPending] = useState<Pending | null>(null);
  const [target, setTarget] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const exportCsv = async () => {
    try {
      const r = app.transfer.exportCsv({ projectId: project || null, includeCompleted });
      if (!r.count) return pushToast({ message: 'No tasks to export', tone: 'error' });
      const where = await saveFile(app.platform, r.filename, r.text, 'text/csv');
      pushToast({ message: `Exported ${r.count} task${r.count === 1 ? '' : 's'}${where ? `. ${where}` : ''}`, tone: 'success' });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
        const f = app.transfer.inspectProjectFile(text);
        setTarget('');
        setPending({ kind: 'project', name: file.name, text, tasks: f.tasks.length, project: f.project?.name ?? null });
      } else {
        setPending({ kind: 'csv', name: file.name, text, preview: app.transfer.previewCsv(text, file.name) });
      }
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  const confirm = () => {
    if (!pending) return;
    try {
      const res =
        pending.kind === 'csv'
          ? app.transfer.importCsv(pending.text, pending.name)
          : app.transfer.importProjectFile(pending.text, pending.project ? {} : { projectId: target || null });
      setPending(null);
      pushToast({
        message: `Imported ${res.created} task${res.created === 1 ? '' : 's'}`,
        tone: 'success',
        action: { label: 'Undo', run: () => app.transfer.undoImport(res) },
      });
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  const issues = pending?.kind === 'csv' ? pending.preview.rows.filter((r) => r.error || r.warning || r.duplicate) : [];

  return (
    <>
      <div className="flex flex-col gap-3 px-4 py-3 text-[0.9rem]">
        <div>
          <div>Export tasks (CSV)</div>
          <div className="text-[0.8rem] text-muted">Opens in Excel, Numbers or Google Sheets, and can be imported back into Focus.</div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Tasks from" htmlFor="csv-project">
            <Select id="csv-project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects and Inbox</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex h-9 items-center gap-2 text-[0.85rem]">
            <Switch checked={includeCompleted} onChange={setIncludeCompleted} label="Include completed tasks" />
            Include completed
          </label>
          <Button size="sm" onClick={() => void exportCsv()}>
            <Download size={14} /> Export CSV
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 text-[0.9rem]">
        <div>
          <div>Import tasks</div>
          <div className="text-[0.8rem] text-muted">
            A CSV from Focus, a spreadsheet with a Title column, a Todoist project CSV, or a Focus project/task file. You see what will be added first;
            existing tasks are never changed.
          </div>
        </div>
        <input ref={input} type="file" accept=".csv,.json,text/csv,application/json" hidden aria-label="Choose a file to import" onChange={(e) => (void choose(e.target.files?.[0]), (e.target.value = ''))} />
        <Button size="sm" className="self-start" onClick={() => input.current?.click()}>
          <FileUp size={14} /> Choose file
        </Button>
      </div>

      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending?.kind === 'project' ? 'Import project file' : 'Import tasks'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending?.kind === 'csv' && pending.preview.tasks === 0} onClick={confirm}>
              {pending?.kind === 'csv' ? `Import ${pending.preview.tasks} task${pending.preview.tasks === 1 ? '' : 's'}` : 'Import'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'csv' && (
          <div className="flex flex-col gap-3 p-4 text-[0.9rem]">
            <p>
              <strong>{pending.name}</strong> ({pending.preview.format === 'todoist' ? 'Todoist project' : pending.preview.format === 'focus' ? 'Focus export' : 'spreadsheet'}):{' '}
              {pending.preview.tasks} task{pending.preview.tasks === 1 ? '' : 's'} to add
              {pending.preview.skipped > 0 && `, ${pending.preview.skipped} skipped`}.
            </p>
            {pending.preview.newProjects.length > 0 && <p className="text-muted">New projects: {pending.preview.newProjects.join(', ')}</p>}
            {pending.preview.newLabels.length > 0 && <p className="text-muted">New labels: {pending.preview.newLabels.map((l) => `@${l}`).join(', ')}</p>}
            {issues.length > 0 && (
              <div>
                <h3 className="mb-1 font-medium">Please check</h3>
                <ul className="max-h-48 overflow-y-auto rounded-lg border border-line text-[0.82rem]" aria-label="Rows to check">
                  {issues.slice(0, 100).map((r) => (
                    <li key={r.line} className="border-b border-line px-2 py-1 last:border-0">
                      Row {r.line}
                      {r.title && ` “${r.title}”`}:{' '}
                      <span className={r.error ? 'text-danger' : 'text-muted'}>{r.error ? `skipped – ${r.error}` : r.duplicate ? 'already in Focus – skipped' : r.warning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {pending?.kind === 'project' && (
          <div className="flex flex-col gap-3 p-4 text-[0.9rem]">
            <p>
              <strong>{pending.name}</strong>: {pending.project ? `project “${pending.project}”` : 'a task'} with {pending.tasks} task{pending.tasks === 1 ? '' : 's'}.
              {pending.project && ' It will be added as a new project.'}
            </p>
            {!pending.project && (
              <Field label="Add to" htmlFor="import-target">
                <Select id="import-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Inbox</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
