import { useEffect, useRef, useState } from 'react';
import { FileText, Sparkles, Wand2 } from 'lucide-react';
import type { Candidate, CaptureSource } from '@/core/capture';
import { formatRelativeDate } from '@/core/dates';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { Button, Dialog, Input, Select, Textarea, cx } from '../primitives';
import { AiDialog } from './AiDialog';
import { useAiEnabled } from './AiFeatures';
import { orderProjects } from './pickers';

async function readFileText(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error('That file is too large (5 MB max)');
  const text = await file.text();
  if (/\.html?$/i.test(file.name) || file.type === 'text/html') {
    // Parse as an inert document; scripts never run.
    return new DOMParser().parseFromString(text, 'text/html').body.textContent ?? '';
  }
  return text;
}

interface Row extends Candidate {
  on: boolean;
}

/** Paste an email, notes or a document; review suggested tasks; create the ones you tick (spec 5.6). */
export function CaptureDialog() {
  const app = useApp();
  const today = useToday();
  const prefs = useDatePrefs();
  const aiEnabled = useAiEnabled();
  const { open, text: initial, list } = useUi((s) => s.capture);
  const close = useUi((s) => s.closeCapture);
  const pushToast = useUi((s) => s.pushToast);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [source, setSource] = useState<CaptureSource | null>(null);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const projects = useQuery(() => orderProjects(app.repos.projects.list()), []);

  useEffect(() => {
    if (!open) return;
    setText(initial);
    setRows(null);
    setError(null);
    // From a Focus link: the tasks are already one per line, so go straight to the review.
    if (list && initial.trim()) {
      try {
        const r = app.capture.analyse(initial, { list: true });
        setSource(r.source);
        setRows(r.candidates.map((c) => ({ ...c, on: true })));
      } catch (err) {
        setError(errorMessage(err));
      }
    }
  }, [open, initial, list, app]);

  const show = (r: { source: CaptureSource; candidates: Candidate[] }) => {
    setSource(r.source);
    setRows(r.candidates.map((c) => ({ ...c, on: c.confidence === 'high' })));
    setError(null);
  };
  const analyse = () => {
    try {
      show(app.capture.analyse(text));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const create = () => {
    if (!rows || !source) return;
    try {
      const made = app.capture.commit(rows.filter((r) => r.on), source, projectId || null);
      pushToast({ message: `Created ${made.length} task${made.length === 1 ? '' : 's'}`, tone: 'success' });
      close();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const chosen = rows?.filter((r) => r.on).length ?? 0;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Capture tasks from text"
      size="lg"
      footer={
        rows ? (
          <>
            <Button onClick={() => setRows(null)}>Back</Button>
            <Button variant="primary" disabled={!chosen} onClick={create}>
              Create {chosen} task{chosen === 1 ? '' : 's'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            {aiEnabled && (
              <Button disabled={!text.trim()} onClick={() => setAiOpen(true)}>
                <Sparkles size={14} /> Find with AI
              </Button>
            )}
            <Button variant="primary" disabled={!text.trim()} onClick={analyse}>
              <Wand2 size={14} /> Find tasks
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {!rows ? (
          <>
            <p className="text-[0.85rem] text-muted">Paste an email, meeting notes or a list. Focus looks for action items on this device — nothing is sent anywhere.</p>
            <Textarea autoFocus rows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to capture from" placeholder={'e.g.\nSubject: Kitchen quote\n\nCould you send me photos by Friday?\n\nAction items\n- Priya to share the design files\n- [ ] Book the survey'} />
            <div className="flex items-center gap-2">
              <input
                ref={file}
                type="file"
                hidden
                accept=".txt,.md,.markdown,.eml,.html,.htm,text/plain,text/markdown,message/rfc822,text/html"
                aria-label="Open a text, Markdown, email or HTML file"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    setText(await readFileText(f));
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
                <FileText size={14} /> Open a file (.txt, .md, .eml, .html)
              </Button>
            </div>
          </>
        ) : (
          <>
            {source?.kind === 'email' && (
              <p className="text-[0.85rem] text-muted">
                Email “{source.subject}”{source.from ? ` from ${source.from}` : ''}. Quoted replies and signatures were ignored.
              </p>
            )}
            {rows.length === 0 ? (
              <p className="text-[0.9rem] text-muted">No tasks found. Put one task per line, or use checkboxes, “Action:” lines or an “Action items” heading — or add tasks with Quick Add.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" aria-label="Suggested tasks">
                {rows.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 px-3 py-2">
                    <input type="checkbox" className="mt-2.5" aria-label={`Create “${r.parsed.title}”`} checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                    <div className="min-w-0 flex-1">
                      <Input
                        aria-label="Task text"
                        value={r.text}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                        className="h-8"
                      />
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[0.75rem] text-muted">
                        <span className={cx(r.confidence === 'high' ? 'text-ok' : 'text-warn')}>{r.why}</span>
                        {r.parsed.scheduledDate && <span>Scheduled {formatRelativeDate(r.parsed.scheduledDate, today, prefs)}</span>}
                        {r.parsed.deadline && <span>Deadline {formatRelativeDate(r.parsed.deadline, today, prefs)}</span>}
                        {r.parsed.priority && r.parsed.priority < 4 && <span>P{r.parsed.priority}</span>}
                        {r.suggestedProjects?.length ? <span>Suggested project: {r.suggestedProjects.join(', ')} (kept as a note)</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <label className="flex items-center gap-2 text-[0.88rem]">
              Add to
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project for new tasks">
                <option value="">Inbox</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </label>
            <p className="text-[0.78rem] text-subtle">Tasks go to the Inbox unless you pick a project above; “#Project” tags never create projects. Each task records where it came from in its description.</p>
          </>
        )}
        {error && <p role="alert" className="text-[0.85rem] text-danger">{error}</p>}
      </div>
      <AiDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        title="Find tasks with AI"
        messages={() => app.ai.extractPrompt(app.capture.analyse(text).source.body || text)}
        run={() => app.capture.analyseWithAi(text)}
        render={(r, done) => (
          <Button
            variant="primary"
            onClick={() => {
              show(r);
              setRows(r.candidates.map((c) => ({ ...c, on: true })));
              done();
            }}
          >
            Review {r.candidates.length} suggestion{r.candidates.length === 1 ? '' : 's'}
          </Button>
        )}
      />
    </Dialog>
  );
}
