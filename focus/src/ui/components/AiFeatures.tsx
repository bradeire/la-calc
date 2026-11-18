import { useState } from 'react';
import { ListTree, Sparkles, Wand2 } from 'lucide-react';
import { formatDuration } from '@/core/dates';
import type { Task } from '@/core/domain/types';
import type { TemplateBody } from '@/core/templates';
import type { AiSuggestion } from '@/services/ai-service';
import { useAction, useApp, useQuery, useToday } from '../hooks';
import { go } from '../router';
import { Button, Field, IconButton, Input, MenuItem, Popover, Textarea } from '../primitives';
import { AiDialog } from './AiDialog';
import { usePopover } from './pickers';

export function useAiEnabled(): boolean {
  const app = useApp();
  return useQuery(() => app.ai.config().enabled, []);
}

function Checklist<T>({ items, label, render, onApply, applyLabel }: { items: T[]; label: string; render: (t: T) => React.ReactNode; onApply: (chosen: T[]) => void; applyLabel: (n: number) => string }) {
  const [on, setOn] = useState(() => items.map(() => true));
  const chosen = items.filter((_, i) => on[i]);
  if (!items.length) return <p className="text-[0.88rem] text-muted">The model had no suggestions.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1" aria-label={label}>
        {items.map((it, i) => (
          <li key={i}>
            <label className="flex items-start gap-2 text-[0.9rem]">
              <input type="checkbox" className="mt-1" checked={on[i]} onChange={(e) => setOn(on.map((x, j) => (j === i ? e.target.checked : x)))} />
              <span>{render(it)}</span>
            </label>
          </li>
        ))}
      </ul>
      <Button variant="primary" className="self-start" disabled={!chosen.length} onClick={() => onApply(chosen)}>
        {applyLabel(chosen.length)}
      </Button>
    </div>
  );
}

/** AI menu in the task details header: break down, suggest details. */
export function TaskAiMenu({ task }: { task: Task }) {
  const app = useApp();
  const act = useAction();
  const enabled = useAiEnabled();
  const menu = usePopover();
  const [mode, setMode] = useState<'breakdown' | 'suggest' | null>(null);
  if (!enabled) return null;
  return (
    <>
      <IconButton ref={menu.ref} label="AI assistant" onClick={menu.toggle}>
        <Sparkles size={16} />
      </IconButton>
      <Popover anchor={menu.ref} open={menu.open} onClose={menu.hide} label="AI assistant" width={240}>
        <div role="menu" className="py-1">
          <MenuItem icon={<ListTree size={15} />} onClick={() => (menu.hide(), setMode('breakdown'))}>
            Break into subtasks
          </MenuItem>
          <MenuItem icon={<Wand2 size={15} />} onClick={() => (menu.hide(), setMode('suggest'))}>
            Suggest priority, project, details
          </MenuItem>
        </div>
      </Popover>
      <AiDialog
        open={mode === 'breakdown'}
        onClose={() => setMode(null)}
        title={`Break down “${task.title}”`}
        messages={() => app.ai.breakdownPrompt(task.id)}
        run={() => app.ai.breakdown(task.id)}
        render={(subs, close) => (
          <Checklist
            items={subs}
            label="Suggested subtasks"
            render={(s) => (
              <>
                {s.title} {s.minutes && <span className="text-subtle">· {formatDuration(s.minutes)}</span>}
              </>
            )}
            applyLabel={(n) => `Add ${n} subtask${n === 1 ? '' : 's'}`}
            onApply={(chosen) => {
              act(() =>
                app.repos.db.transaction(() => chosen.map((s) => app.tasks.create({ title: s.title, parentId: task.id, durationMinutes: s.minutes }))),
                { success: `Added ${chosen.length} subtasks` },
              );
              close();
            }}
          />
        )}
      />
      <AiDialog
        open={mode === 'suggest'}
        onClose={() => setMode(null)}
        title={`Suggestions for “${task.title}”`}
        messages={() => app.ai.suggestPrompt(task.id)}
        run={() => app.ai.suggest(task.id)}
        render={(s: AiSuggestion, close) => {
          const rows: { key: keyof AiSuggestion; text: string }[] = [];
          if (s.priority) rows.push({ key: 'priority', text: `Priority P${s.priority}` });
          if (s.projectId) rows.push({ key: 'projectId', text: `Move to project ${s.projectName}` });
          if (s.labelIds?.length) rows.push({ key: 'labelIds', text: `Add labels ${s.labelNames!.map((n) => `@${n}`).join(', ')}` });
          if (s.durationMinutes) rows.push({ key: 'durationMinutes', text: `Estimate ${formatDuration(s.durationMinutes)}` });
          if (s.description) rows.push({ key: 'description', text: `${task.description ? 'Replace' : 'Add'} description: “${s.description}”` });
          return (
            <Checklist
              items={rows}
              label="Suggested changes"
              render={(r) => r.text}
              applyLabel={(n) => `Apply ${n} change${n === 1 ? '' : 's'}`}
              onApply={(chosen) => {
                const keys = new Set(chosen.map((c) => c.key));
                act((force) =>
                  app.repos.db.transaction(() => {
                    if (keys.has('projectId') && s.projectId) app.tasks.move([task.id], { projectId: s.projectId });
                    return app.tasks.update(
                      task.id,
                      {
                        ...(keys.has('priority') && s.priority ? { priority: s.priority } : {}),
                        ...(keys.has('labelIds') && s.labelIds ? { labelIds: [...new Set([...task.labelIds, ...s.labelIds])] } : {}),
                        ...(keys.has('durationMinutes') && s.durationMinutes ? { durationMinutes: s.durationMinutes } : {}),
                        ...(keys.has('description') && s.description ? { description: s.description } : {}),
                      },
                      { force },
                    );
                  }),
                  { success: 'Suggestions applied' },
                );
                close();
              }}
            />
          );
        }}
      />
    </>
  );
}

export function ProjectSummaryDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const app = useApp();
  const act = useAction();
  return (
    <AiDialog
      open={open}
      onClose={onClose}
      title="Project summary"
      messages={() => app.ai.summaryPrompt(projectId)}
      run={() => app.ai.summariseProject(projectId)}
      render={(r, close) => (
        <div className="flex flex-col gap-2 text-[0.9rem]">
          <p className="whitespace-pre-wrap">{r.summary}</p>
          {r.risks && r.risks.length > 0 && (
            <>
              <h3 className="font-semibold">Risks</h3>
              <ul className="list-disc pl-5">{r.risks.map((x) => <li key={x}>{x}</li>)}</ul>
            </>
          )}
          <Button
            className="self-start"
            onClick={() => {
              const p = app.repos.projects.get(projectId)!;
              const stamp = new Date().toLocaleDateString('en-GB');
              act(() => app.projects.update(projectId, { notes: `${p.notes ? `${p.notes}\n\n` : ''}AI summary (${stamp}):\n${r.summary}` }), { success: 'Added to project notes' });
              close();
            }}
          >
            Save to project notes
          </Button>
        </div>
      )}
    />
  );
}

/** "Describe it in words" → a validated filter query, shown before use. */
export function FilterFromWords({ onQuery }: { onQuery: (q: string) => void }) {
  const app = useApp();
  const enabled = useAiEnabled();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-60 flex-1">
        <Field label="Or describe it in words (AI)" htmlFor="filter-words">
          <Input id="filter-words" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. urgent home tasks due this week" />
        </Field>
      </div>
      <Button disabled={!text.trim()} onClick={() => setOpen(true)}>
        <Sparkles size={14} /> Suggest a query
      </Button>
      <AiDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Filter from a description"
        messages={() => app.ai.filterPrompt(text)}
        run={() => app.ai.generateFilter(text)}
        render={(q, close) => (
          <div className="flex flex-col gap-2">
            <code className="rounded bg-surface-2 px-2 py-1">{q}</code>
            <Button variant="primary" className="self-start" onClick={() => (onQuery(q), close())}>
              Use this query
            </Button>
          </div>
        )}
      />
    </div>
  );
}

/** Generate a template from a description; previewed before anything is created. */
export function TemplateFromWords({ onCreated }: { onCreated: () => void }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const enabled = useAiEnabled();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <Field label="Or describe a project and let the AI draft a template" htmlFor="tpl-words">
        <Textarea id="tpl-words" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. redecorating the spare bedroom over a month" />
      </Field>
      <Button className="self-start" disabled={!text.trim()} onClick={() => setOpen(true)}>
        <Sparkles size={14} /> Draft a template
      </Button>
      <AiDialog
        open={open}
        onClose={() => setOpen(false)}
        title="AI-drafted project"
        messages={() => app.ai.templatePrompt(text)}
        run={() => app.ai.generateTemplate(text)}
        render={(body: TemplateBody, close) => <DraftPreview body={body} today={today} onCreate={(name, start) => {
          const p = act(() => app.templates.instantiateBody(body, { name, startDate: start }));
          if (p) {
            close();
            onCreated();
            go({ name: 'project', id: p.id });
          }
        }} />}
      />
    </div>
  );
}

function DraftPreview({ body, today, onCreate }: { body: TemplateBody; today: string; onCreate: (name: string, start: string) => void }) {
  const [name, setName] = useState(body.project.description || 'New project');
  const [start, setStart] = useState(today);
  return (
    <div className="flex flex-col gap-3">
      <ul className="max-h-60 overflow-auto text-[0.88rem]">
        {body.tasks.map((t) => (
          <li key={t.ref} className="border-b border-line py-1">
            {t.title} <span className="text-subtle">{t.section ? `· ${t.section}` : ''}{t.scheduledOffset !== null ? ` · day ${t.scheduledOffset}` : ''}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Start date" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <Button variant="primary" className="self-start" disabled={!name.trim()} onClick={() => onCreate(name, start)}>
        Create project with {body.tasks.length} tasks
      </Button>
    </div>
  );
}

export function PlanReviewButton() {
  const app = useApp();
  const enabled = useAiEnabled();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Sparkles size={14} /> Ask the AI for advice
      </Button>
      <AiDialog
        open={open}
        onClose={() => setOpen(false)}
        title="AI review of your plan"
        messages={() => app.ai.reviewPrompt()}
        run={() => app.ai.review()}
        render={(advice) => (
          <ul className="flex flex-col gap-1.5 text-[0.9rem]">
            {advice.map((a, i) => (
              <li key={i}>
                {a.taskTitle && <strong>{a.taskTitle}: </strong>}
                {a.text}
              </li>
            ))}
            <li className="pt-1 text-[0.8rem] text-subtle">Advice only — nothing has been changed.</li>
          </ul>
        )}
      />
    </>
  );
}
