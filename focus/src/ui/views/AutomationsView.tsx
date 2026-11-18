import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, CircleMinus, FlaskConical, History, Pencil, Plus, Trash2, Workflow, X, Zap } from 'lucide-react';
import { PROJECT_TRIGGERS, TIME_TRIGGERS, type AutomationAction, type AutomationInput, type TriggerType } from '@/core/automation/types';
import type { Group } from '@/core/filters/types';
import { STATUS_LABELS, TASK_STATUSES } from '@/core/domain/types';
import { errorMessage, useAction, useApp, useQuery } from '../hooks';
import { go, navigate } from '../router';
import { Button, EmptyState, Field, IconButton, Input, Select, Switch, cx } from '../primitives';
import { GroupHeading, ViewBody } from '../components/common';
import { ViewHeader } from '../layout/Chrome';
import { asGroup, GroupEditor } from './FiltersView';

const TRIGGER_LABELS: Record<TriggerType, string> = {
  'task.created': 'A task is created',
  'task.completed': 'A task is completed',
  'subtask.completed': 'A subtask is completed',
  'task.overdue': 'A task becomes overdue',
  'deadline.approaching': 'A deadline is approaching',
  'scheduled.reached': 'A task’s scheduled time arrives',
  'task.priorityChanged': 'A task’s priority changes',
  'task.labelAdded': 'A label is added to a task',
  'task.moved': 'A task is moved to another project',
  'task.waitingTooLong': 'A task has been “waiting” too long',
  'project.created': 'A project is created',
  'project.completed': 'A project’s last task is completed',
};

const ACTION_LABELS: Record<AutomationAction['type'], string> = {
  createTask: 'Create a task', createSubtask: 'Add a subtask', setPriority: 'Set priority', addLabel: 'Add a label', removeLabel: 'Remove a label',
  moveToProject: 'Move to project', setStatus: 'Set status', scheduleInDays: 'Schedule', createReminder: 'Add a reminder', notify: 'Notify me',
  webhook: 'Call a webhook', archiveTask: 'Archive the task', archiveProject: 'Archive the project', applyTemplate: 'Add tasks from a template',
};

function defaultAction(type: AutomationAction['type']): AutomationAction {
  switch (type) {
    case 'createTask': return { type, title: 'Follow up: {{task.title}}', projectId: null, sameProject: true, scheduleInDays: 0, priority: 4 };
    case 'createSubtask': return { type, title: 'Check {{task.title}}' };
    case 'setPriority': return { type, priority: 1 };
    case 'addLabel':
    case 'removeLabel': return { type, labelId: '' };
    case 'moveToProject': return { type, projectId: null };
    case 'setStatus': return { type, status: 'waiting' };
    case 'scheduleInDays': return { type, days: 0 };
    case 'createReminder': return { type, minutesBefore: 30 };
    case 'notify': return { type, message: '{{task.title}} needs attention' };
    case 'webhook': return { type, webhookId: '' };
    case 'applyTemplate': return { type, templateId: 'builtin:holiday' };
    default: return { type } as AutomationAction;
  }
}

/** The spec's example automations, ready to adapt. */
const PRESETS: { name: string; input: AutomationInput }[] = [
  { name: 'Tell me when a task becomes overdue', input: { name: 'Overdue alert', trigger: { type: 'task.overdue' }, actions: [{ type: 'notify', message: '“{{task.title}}” is overdue' }] } },
  { name: 'Remind me to follow up after 3 days of waiting', input: { name: 'Chase waiting tasks', trigger: { type: 'task.waitingTooLong', days: 3 }, actions: [{ type: 'createTask', title: 'Follow up: {{task.title}}', sameProject: true, scheduleInDays: 0, projectId: null, priority: 2 }] } },
  { name: 'Archive a project when all its tasks are done', input: { name: 'Archive finished projects', trigger: { type: 'project.completed' }, actions: [{ type: 'archiveProject' }] } },
  { name: 'Fill trip projects from the holiday template', input: { name: 'Trip checklist', trigger: { type: 'project.created', nameContains: 'trip' }, actions: [{ type: 'applyTemplate', templateId: 'builtin:holiday' }] } },
  { name: 'Warn me a day before a deadline', input: { name: 'Deadline tomorrow', trigger: { type: 'deadline.approaching', days: 1 }, actions: [{ type: 'notify', message: '“{{task.title}}” is due soon' }] } },
];

export function AutomationsView() {
  const app = useApp();
  const act = useAction();
  const list = useQuery(() => app.automations.list(), []);
  const runs = useQuery(() => app.automations.runs(undefined, 50), []);
  const runCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) if (r.status === 'succeeded') m.set(r.automationId, (m.get(r.automationId) ?? 0) + 1);
    return m;
  }, [runs]);
  const addPreset = (input: AutomationInput) => {
    const id = act(() => app.automations.save(input), { success: `Added “${input.name}”` });
    if (id) navigate(`/automation/${id}`);
  };
  return (
    <>
      <ViewHeader
        title="Automations"
        icon={<Workflow size={22} className="text-violet-500" />}
        subtitle="When something happens, Focus does something for you"
        actions={
          <Button size="sm" variant="primary" onClick={() => navigate('/automation/new')}>
            <Plus size={15} /> New
          </Button>
        }
      />
      <ViewBody>
        {list.length === 0 && <EmptyState icon={<Workflow size={26} />} title="No automations yet" body="Start from an example below or build your own. Automations run on this device." />}
        <ul>
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-b border-line py-2">
              <Switch checked={a.enabled} onChange={(v) => act(() => app.automations.setEnabled(a.id, v))} label={`${a.enabled ? 'Turn off' : 'Turn on'} ${a.name}`} />
              <button type="button" onClick={() => navigate(`/automation/${a.id}`)} className="min-w-0 flex-1 text-left">
                <span className={cx('block truncate', !a.enabled && 'text-muted')}>{a.name}</span>
                <span className="block truncate text-[0.8rem] text-muted">
                  {TRIGGER_LABELS[a.trigger.type]} → {a.actions.map((x) => ACTION_LABELS[x.type].toLowerCase()).join(', ')}
                </span>
              </button>
              <span className="text-[0.78rem] text-subtle">{runCount.get(a.id) ? `${runCount.get(a.id)} recent runs` : 'Not run yet'}</span>
              <IconButton size="sm" label={`Edit ${a.name}`} onClick={() => navigate(`/automation/${a.id}`)}>
                <Pencil size={14} />
              </IconButton>
              <IconButton size="sm" label={`Delete ${a.name}`} onClick={() => act(() => app.automations.remove(a.id))}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
        <GroupHeading title="Examples" collapsible defaultOpen={list.length === 0}>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.filter((p) => !list.some((a) => a.name === p.input.name)).map((p) => (
              <button key={p.name} type="button" onClick={() => addPreset(p.input)} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-left text-[0.88rem] hover:bg-surface-2">
                <Zap size={14} className="text-violet-500" /> {p.name}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[0.8rem] text-subtle">Recurring tasks already create their next occurrence automatically when completed.</p>
        </GroupHeading>
        <RunHistory />
      </ViewBody>
    </>
  );
}

function RunHistory({ automationId }: { automationId?: string }) {
  const app = useApp();
  const runs = useQuery(() => app.automations.runs(automationId, 30), [automationId]);
  const names = useQuery(() => new Map(app.automations.list().map((a) => [a.id, a.name])), []);
  return (
    <GroupHeading title="History" count={runs.length} collapsible defaultOpen={!!automationId}>
      {runs.length === 0 && <p className="py-3 text-[0.88rem] text-muted">Nothing has run yet.</p>}
      <ul className="mt-1 flex flex-col">
        {runs.map((r) => (
          <li key={r.id} className="flex items-start gap-2 border-b border-line py-1.5 text-[0.84rem]">
            {r.status === 'succeeded' ? <CircleCheck size={15} className="mt-0.5 text-ok" aria-label="Succeeded" /> : r.status === 'failed' ? <CircleAlert size={15} className="mt-0.5 text-danger" aria-label="Failed" /> : <CircleMinus size={15} className="mt-0.5 text-subtle" aria-label={r.status} />}
            <span className="min-w-0 flex-1">
              {!automationId && <strong className="font-medium">{names.get(r.automationId) ?? 'Deleted automation'} · </strong>}
              {r.error ?? ((r.details.actions as string[] | undefined)?.join('; ') || r.status)}
            </span>
            <time className="shrink-0 text-subtle" dateTime={r.startedAt}>
              {new Date(r.startedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
            </time>
          </li>
        ))}
      </ul>
    </GroupHeading>
  );
}

function ActionEditor({ action, onChange, onRemove, projectTrigger }: { action: AutomationAction; onChange: (a: AutomationAction) => void; onRemove: () => void; projectTrigger: boolean }) {
  const app = useApp();
  const projects = useQuery(() => app.repos.projects.list(), []);
  const labels = useQuery(() => app.repos.labels.list(), []);
  const webhooks = useQuery(() => app.webhooks.list(), []);
  const templates = useQuery(() => app.templates.list(), []);
  const sel = 'h-8 text-[0.85rem]';
  // Project triggers have no task, so only project-level actions apply.
  const allowed = (Object.keys(ACTION_LABELS) as AutomationAction['type'][]).filter((t) =>
    projectTrigger ? ['createTask', 'notify', 'webhook', 'archiveProject', 'applyTemplate'].includes(t) : true,
  );
  let body: React.ReactNode;
  switch (action.type) {
    case 'createTask':
      body = (
        <>
          <Input aria-label="New task title" className="h-8 min-w-48 flex-1" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} />
          <Select aria-label="Where" className={sel} value={action.sameProject ? 'same' : (action.projectId ?? '')} onChange={(e) => onChange({ ...action, sameProject: e.target.value === 'same', projectId: e.target.value === 'same' || !e.target.value ? null : e.target.value })}>
            <option value="same">in the same project</option>
            <option value="">in the Inbox</option>
            {projects.map((p) => <option key={p.id} value={p.id}>in {p.name}</option>)}
          </Select>
          <Select aria-label="When" className={sel} value={action.scheduleInDays ?? ''} onChange={(e) => onChange({ ...action, scheduleInDays: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">no date</option>
            <option value={0}>today</option>
            <option value={1}>tomorrow</option>
            <option value={7}>in a week</option>
          </Select>
        </>
      );
      break;
    case 'createSubtask':
      body = <Input aria-label="Subtask title" className="h-8 flex-1" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} />;
      break;
    case 'setPriority':
      body = (
        <Select aria-label="Priority" className={sel} value={action.priority} onChange={(e) => onChange({ ...action, priority: Number(e.target.value) })}>
          {[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}
        </Select>
      );
      break;
    case 'addLabel':
    case 'removeLabel':
      body = (
        <Select aria-label="Label" className={sel} value={action.labelId} onChange={(e) => onChange({ ...action, labelId: e.target.value })}>
          <option value="">Choose a label…</option>
          {labels.map((l) => <option key={l.id} value={l.id}>@{l.name}</option>)}
        </Select>
      );
      break;
    case 'moveToProject':
      body = (
        <Select aria-label="Project" className={sel} value={action.projectId ?? ''} onChange={(e) => onChange({ ...action, projectId: e.target.value || null })}>
          <option value="">Inbox</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      );
      break;
    case 'setStatus':
      body = (
        <Select aria-label="Status" className={sel} value={action.status} onChange={(e) => onChange({ ...action, status: e.target.value as typeof action.status })}>
          {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </Select>
      );
      break;
    case 'scheduleInDays':
      body = <Input type="number" min={0} aria-label="Days from today" className="h-8 !w-24" value={action.days} onChange={(e) => onChange({ ...action, days: Math.max(0, Number(e.target.value)) })} />;
      break;
    case 'createReminder':
      body = <Input type="number" min={0} aria-label="Minutes before" className="h-8 !w-24" value={action.minutesBefore} onChange={(e) => onChange({ ...action, minutesBefore: Math.max(0, Number(e.target.value)) })} />;
      break;
    case 'notify':
      body = <Input aria-label="Message" className="h-8 flex-1" value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} />;
      break;
    case 'webhook':
      body = (
        <Select aria-label="Webhook" className={sel} value={action.webhookId} onChange={(e) => onChange({ ...action, webhookId: e.target.value })}>
          <option value="">{webhooks.length ? 'Choose a webhook…' : 'Add a webhook in Settings first'}</option>
          {webhooks.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      );
      break;
    case 'applyTemplate':
      body = (
        <Select aria-label="Template" className={sel} value={action.templateId} onChange={(e) => onChange({ ...action, templateId: e.target.value })}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      );
      break;
    default:
      body = null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-2/60 p-1.5">
      <Select aria-label="Action" className={sel} value={action.type} onChange={(e) => onChange(defaultAction(e.target.value as AutomationAction['type']))}>
        {allowed.map((t) => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
      </Select>
      {body}
      <IconButton size="sm" label="Remove action" onClick={onRemove} className="ml-auto">
        <X size={14} />
      </IconButton>
    </div>
  );
}

export function AutomationEditorView({ id }: { id: string | null }) {
  const app = useApp();
  const act = useAction();
  const existing = useQuery(() => (id ? app.repos.automations.get(id) : undefined), [id]);
  const [name, setName] = useState(existing?.name ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [trigger, setTrigger] = useState(existing?.trigger ?? { type: 'task.created' as TriggerType });
  const [conditions, setConditions] = useState<Group | null>(existing?.conditions ? asGroup(existing.conditions.root) : null);
  const [actions, setActions] = useState<AutomationAction[]>(existing?.actions ?? [defaultAction('notify')]);
  const [limit, setLimit] = useState(existing?.maxRunsPerHour ?? 60);
  const [testTask, setTestTask] = useState('');
  const [testResult, setTestResult] = useState<{ matches: boolean; reason: string; actions: string[] } | null>(null);
  const labels = useQuery(() => app.repos.labels.list(), []);
  const candidates = useQuery(() => app.repos.tasks.listForFilters().slice(0, 300), []);
  const projects = useQuery(() => app.repos.projects.list(), []);
  const isProject = PROJECT_TRIGGERS.includes(trigger.type);
  const input = (): AutomationInput => ({
    name,
    enabled,
    trigger,
    conditions: !isProject && conditions && conditions.children.length ? { v: 1, root: conditions } : null,
    actions,
    maxRunsPerHour: limit,
  });
  const save = () => {
    const saved = act(() => app.automations.save(input(), id ?? undefined), { success: 'Automation saved' });
    if (saved) go({ name: 'automations' });
  };
  const runTest = () => {
    try {
      setTestResult(app.automations.test(input(), isProject ? { projectId: testTask } : { taskId: testTask }));
    } catch (err) {
      setTestResult({ matches: false, reason: errorMessage(err), actions: [] });
    }
  };

  return (
    <>
      <ViewHeader
        title={id ? 'Edit automation' : 'New automation'}
        icon={<Workflow size={22} className="text-violet-500" />}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => history.back()}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!name.trim() || !actions.length} onClick={save}>
              Save
            </Button>
          </>
        }
      />
      <ViewBody>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <Field label="Name" htmlFor="auto-name">
                <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chase waiting tasks" />
              </Field>
            </div>
            <label className="flex items-center gap-2 pb-2 text-[0.88rem]">
              <Switch checked={enabled} onChange={setEnabled} label="Enabled" /> Enabled
            </label>
          </div>

          <section aria-label="When">
            <h2 className="mb-2 text-[0.95rem] font-semibold">When</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Trigger" value={trigger.type} onChange={(e) => setTrigger({ type: e.target.value as TriggerType })}>
                {Object.entries(TRIGGER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              {(trigger.type === 'deadline.approaching' || trigger.type === 'task.waitingTooLong') && (
                <label className="flex items-center gap-1.5 text-[0.88rem]">
                  {trigger.type === 'deadline.approaching' ? 'within' : 'for at least'}
                  <Input type="number" min={0} max={365} aria-label="Days" className="!w-20" value={trigger.days ?? (trigger.type === 'deadline.approaching' ? 1 : 3)} onChange={(e) => setTrigger({ ...trigger, days: Number(e.target.value) })} /> days
                </label>
              )}
              {trigger.type === 'task.labelAdded' && (
                <Select aria-label="Which label" value={trigger.labelId ?? ''} onChange={(e) => setTrigger({ ...trigger, labelId: e.target.value || undefined })}>
                  <option value="">any label</option>
                  {labels.map((l) => <option key={l.id} value={l.id}>@{l.name}</option>)}
                </Select>
              )}
              {isProject && (
                <label className="flex items-center gap-1.5 text-[0.88rem]">
                  and its name contains
                  <Input aria-label="Name contains" className="!w-40" value={trigger.nameContains ?? ''} onChange={(e) => setTrigger({ ...trigger, nameContains: e.target.value || undefined })} placeholder="(anything)" />
                </label>
              )}
            </div>
            {TIME_TRIGGERS.includes(trigger.type) && <p className="mt-1 text-[0.8rem] text-subtle">Checked every minute while Focus is open, and when it starts. Each task triggers this once per occurrence.</p>}
          </section>

          {!isProject && (
            <section aria-label="Only if">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[0.95rem] font-semibold">Only if (optional)</h2>
                {conditions ? (
                  <Button size="sm" variant="ghost" onClick={() => setConditions(null)}>
                    Remove conditions
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConditions({ kind: 'group', op: 'and', children: [{ kind: 'rule', field: 'priority', op: '=', value: 1 }] })}>
                    <Plus size={13} /> Add conditions
                  </Button>
                )}
              </div>
              {conditions && <GroupEditor group={conditions} onChange={setConditions} />}
            </section>
          )}

          <section aria-label="Then">
            <h2 className="mb-2 text-[0.95rem] font-semibold">Then</h2>
            <div className="flex flex-col gap-1.5">
              {actions.map((a, i) => (
                <ActionEditor key={i} action={a} projectTrigger={isProject} onChange={(n) => setActions(actions.map((x, j) => (j === i ? n : x)))} onRemove={() => setActions(actions.filter((_, j) => j !== i))} />
              ))}
            </div>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setActions([...actions, defaultAction(isProject ? 'notify' : 'addLabel')])}>
              <Plus size={13} /> Action
            </Button>
            <p className="mt-1 text-[0.8rem] text-subtle">Titles and messages can use {'{{task.title}}'}, {'{{project.name}}'} and {'{{date}}'}.</p>
          </section>

          <section aria-label="Safety">
            <label className="flex items-center gap-2 text-[0.88rem]">
              Run at most
              <Input type="number" min={1} max={1000} aria-label="Runs per hour" className="!w-20" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              times per hour
            </label>
            <p className="mt-1 text-[0.8rem] text-subtle">An automation never runs twice for the same event and cannot trigger itself in a loop.</p>
          </section>

          <section aria-label="Test" className="rounded-xl border border-line p-3">
            <h2 className="mb-2 flex items-center gap-1.5 text-[0.95rem] font-semibold">
              <FlaskConical size={15} /> Test without changing anything
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label={isProject ? 'Test project' : 'Test task'} value={testTask} onChange={(e) => setTestTask(e.target.value)} className="max-w-80">
                <option value="">{isProject ? 'Choose a project…' : 'Choose a task…'}</option>
                {isProject ? projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>) : candidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </Select>
              <Button size="sm" disabled={!testTask} onClick={runTest}>
                Run test
              </Button>
            </div>
            {testResult && (
              <div className={cx('mt-2 rounded-lg px-3 py-2 text-[0.88rem]', testResult.matches ? 'bg-[color-mix(in_srgb,var(--ok)_12%,transparent)]' : 'bg-surface-2')} role="status">
                <strong>{testResult.matches ? 'Would run.' : 'Would not run.'}</strong> {testResult.reason}
                {testResult.matches && (
                  <ul className="mt-1 list-disc pl-5">
                    {testResult.actions.map((a) => <li key={a}>{a}</li>)}
                  </ul>
                )}
              </div>
            )}
          </section>
          {id && <RunHistory automationId={id} />}
          {!id && (
            <p className="flex items-center gap-1.5 text-[0.8rem] text-subtle">
              <History size={13} /> Run history appears here after saving.
            </p>
          )}
        </div>
      </ViewBody>
    </>
  );
}
