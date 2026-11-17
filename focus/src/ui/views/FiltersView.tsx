import { useEffect, useMemo, useState } from 'react';
import { Filter, FolderTree, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import type { Condition, DateField, Group, Rule } from '@/core/filters/types';
import { DATE_FIELDS } from '@/core/filters/types';
import { STATUS_LABELS, TASK_STATUSES } from '@/core/domain/types';
import { useAction, useApp, useQuery } from '../hooks';
import { go, navigate } from '../router';
import { Button, EmptyState, IconButton, Input, Select, cx } from '../primitives';
import { GroupHeading, ViewBody } from '../components/common';
import { TaskList } from '../components/TaskList';
import { OrganisedTaskList, ViewOptionsButton } from '../components/ViewOptions';
import { ViewHeader } from '../layout/Chrome';
import { FilterFromWords } from '../components/AiFeatures';

/** One-click starting points (the spec's example filters). */
const PRESETS: { name: string; query: string }[] = [
  { name: 'Priority 1', query: 'p1' },
  { name: 'Due this week', query: 'due:this-week' },
  { name: 'No scheduled date', query: 'scheduled:none' },
  { name: 'Waiting on others', query: 'status:waiting' },
  { name: 'Quick wins (< 15 min)', query: 'duration<15' },
  { name: 'Overdue', query: 'overdue' },
  { name: 'Blocked', query: 'blocked' },
];

export function FiltersView() {
  const app = useApp();
  const act = useAction();
  const filters = useQuery(() => app.filters.list(), []);
  const counts = useQuery(() => new Map(filters.map((f) => [f.id, f.definition ? app.filters.run(f.definition.root).length : null])), [filters]);
  const create = (name: string, query: string) => {
    const parsed = app.filters.parse(query);
    if (!parsed.definition) return;
    const id = act(() => app.filters.save({ name, definition: parsed.definition! }));
    if (id) go({ name: 'filter', id });
  };
  return (
    <>
      <ViewHeader
        title="Filters"
        icon={<Filter size={22} className="text-p3" />}
        actions={
          <Button size="sm" variant="primary" onClick={() => navigate('/filter/new')}>
            <Plus size={15} /> New
          </Button>
        }
      />
      <ViewBody>
        {filters.length === 0 && (
          <EmptyState icon={<Filter size={26} />} title="No saved filters yet" body="Filters gather tasks from every project by priority, dates, labels, status, duration or dependencies. Start from one of these:" />
        )}
        {filters.length > 0 && (
          <ul>
            {filters.map((f) => (
              <li key={f.id} className="flex items-center gap-2 border-b border-line py-1.5">
                <button type="button" onClick={() => go({ name: 'filter', id: f.id })} className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left">
                  <Filter size={16} style={{ color: f.color }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.name}</span>
                    <code className="block truncate text-[0.78rem] text-muted">{f.query}</code>
                  </span>
                  <span className="text-[0.8rem] text-subtle">{counts.get(f.id) ?? '—'}</span>
                </button>
                <IconButton size="sm" label={f.isFavorite ? `Unpin ${f.name}` : `Pin ${f.name} to the sidebar`} onClick={() => act(() => app.filters.setFavorite(f.id, !f.isFavorite))}>
                  <Star size={14} className={f.isFavorite ? 'text-warn' : ''} fill={f.isFavorite ? 'currentColor' : 'none'} />
                </IconButton>
                <IconButton size="sm" label={`Edit ${f.name}`} onClick={() => navigate(`/filter/${f.id}/edit`)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton size="sm" label={`Delete ${f.name}`} onClick={() => act(() => app.filters.remove(f.id))}>
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <GroupHeading title="Quick start" collapsible defaultOpen={filters.length === 0}>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.filter((p) => !filters.some((f) => f.query === p.query)).map((p) => (
              <button key={p.query} type="button" onClick={() => create(p.name, p.query)} className="rounded-lg border border-line px-3 py-1.5 text-left text-[0.88rem] hover:bg-surface-2">
                {p.name} <code className="ml-1 text-[0.78rem] text-muted">{p.query}</code>
              </button>
            ))}
          </div>
        </GroupHeading>
      </ViewBody>
    </>
  );
}

export function FilterResultsView({ id }: { id: string }) {
  const app = useApp();
  const filter = useQuery(() => app.repos.filters.get(id), [id]);
  const tasks = useQuery(() => (filter?.definition ? app.filters.run(filter.definition.root) : []), [filter]);
  if (!filter) return <EmptyState icon={<Filter size={26} />} title="Filter not found" action={<Button onClick={() => go({ name: 'filters' })}>All filters</Button>} />;
  return (
    <>
      <ViewHeader
        title={filter.name}
        icon={<Filter size={22} style={{ color: filter.color }} />}
        subtitle={<code>{filter.query}</code>}
        actions={
          <>
            <ViewOptionsButton viewId={`filter:${id}`} />
            <Button size="sm" variant="ghost" onClick={() => navigate(`/filter/${id}/edit`)}>
              <Pencil size={14} /> Edit
            </Button>
          </>
        }
      />
      <ViewBody>
        {!filter.definition && <p className="text-danger">This filter could not be read. Edit it to repair it.</p>}
        <p className="mb-2 text-[0.85rem] text-muted">{tasks.length} task{tasks.length === 1 ? '' : 's'}</p>
        <OrganisedTaskList viewId={`filter:${id}`} tasks={tasks} tree={false} showProject draggable ariaLabel={`Tasks matching ${filter.name}`} />
        {tasks.length === 0 && <EmptyState icon={<Filter size={26} />} title="Nothing matches right now" />}
      </ViewBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor: visual builder ⇄ query text, with live preview
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<Rule['field'], string> = {
  priority: 'Priority', status: 'Status', project: 'Project', label: 'Labels', scheduled: 'Scheduled date', deadline: 'Deadline',
  start: 'Start date', due: 'Scheduled or deadline', completed: 'Completed date', created: 'Created date', duration: 'Estimate (min)',
  text: 'Text', dependency: 'Dependencies', recurring: 'Repeats', subtask: 'Is a subtask',
};

export function defaultRule(field: Rule['field']): Rule {
  switch (field) {
    case 'priority': return { kind: 'rule', field, op: '=', value: 1 };
    case 'status': return { kind: 'rule', field, op: 'is', value: ['waiting'] };
    case 'project': return { kind: 'rule', field, op: 'in', value: [] };
    case 'label': return { kind: 'rule', field, op: 'hasAny', value: [] };
    case 'duration': return { kind: 'rule', field, op: '<', value: 15 };
    case 'text': return { kind: 'rule', field, op: 'contains', value: '' };
    case 'dependency': return { kind: 'rule', field, op: 'blocked' };
    case 'recurring':
    case 'subtask': return { kind: 'rule', field, op: 'yes' };
    default: return { kind: 'rule', field, op: 'on', value: 'this-week' };
  }
}

const DATE_OP_LABELS: Record<string, string> = {
  on: 'is in / on', before: 'before', after: 'after', onOrBefore: 'on or before', onOrAfter: 'on or after',
  between: 'between', none: 'is not set', any: 'is set', overdue: 'is overdue',
};
const DATE_SUGGESTIONS = ['today', 'tomorrow', 'this-week', 'next-week', 'this-month', 'next-month', 'next-7-days', 'last-7-days', '+7d', '-7d'];

function MultiPick({ options, value, onChange, label }: { options: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button key={o.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])} className={cx('rounded-md border px-2 py-0.5 text-[0.82rem]', on ? 'border-accent bg-surface-2 text-fg' : 'border-line text-muted hover:text-fg')}>
            {o.name}
          </button>
        );
      })}
      {options.length === 0 && <span className="text-[0.82rem] text-subtle">None yet</span>}
    </div>
  );
}

function RuleEditor({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  const app = useApp();
  const projects = useQuery(() => [{ id: 'inbox', name: 'Inbox' }, ...app.repos.projects.list({ includeArchived: true }).map((p) => ({ id: p.id, name: p.name }))], []);
  const labels = useQuery(() => app.repos.labels.list().map((l) => ({ id: l.id, name: l.name })), []);
  const isDate = (DATE_FIELDS as readonly string[]).includes(rule.field);
  const sel = 'h-8 text-[0.85rem]';
  let body: React.ReactNode = null;
  switch (rule.field) {
    case 'priority':
      body = (
        <>
          <Select aria-label="Comparison" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
            {['=', '!=', '<', '<=', '>', '>='].map((o) => <option key={o} value={o}>{{ '=': 'is', '!=': 'is not', '<': 'higher than', '<=': 'at least', '>': 'lower than', '>=': 'at most' }[o]}</option>)}
          </Select>
          <Select aria-label="Priority" className={sel} value={rule.value} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}
          </Select>
        </>
      );
      break;
    case 'status':
      body = (
        <>
          <Select aria-label="Comparison" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'is' | 'isNot' })}>
            <option value="is">is one of</option>
            <option value="isNot">is not</option>
          </Select>
          <MultiPick label="Statuses" options={TASK_STATUSES.map((s) => ({ id: s, name: STATUS_LABELS[s] }))} value={rule.value} onChange={(v) => onChange({ ...rule, value: v })} />
        </>
      );
      break;
    case 'project':
      body = (
        <>
          <Select aria-label="Comparison" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'in' | 'notIn' })}>
            <option value="in">is in (incl. sub-projects)</option>
            <option value="notIn">is not in</option>
          </Select>
          <MultiPick label="Projects" options={projects} value={rule.value} onChange={(v) => onChange({ ...rule, value: v })} />
        </>
      );
      break;
    case 'label':
      body = (
        <>
          <Select aria-label="Comparison" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'hasAny' })}>
            <option value="hasAny">has any of</option>
            <option value="hasAll">has all of</option>
            <option value="hasNone">has none of (none selected = no labels)</option>
          </Select>
          <MultiPick label="Labels" options={labels} value={rule.value} onChange={(v) => onChange({ ...rule, value: v })} />
        </>
      );
      break;
    case 'duration':
      body = (
        <>
          <Select aria-label="Comparison" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
            {[['<', 'less than'], ['<=', 'at most'], ['>', 'more than'], ['>=', 'at least'], ['=', 'exactly'], ['none', 'not set'], ['any', 'is set']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          {rule.op !== 'none' && rule.op !== 'any' && <Input type="number" min={1} aria-label="Minutes" className="h-8 !w-24" value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: Number(e.target.value) })} />}
        </>
      );
      break;
    case 'text':
      body = <Input aria-label="Text contains" placeholder="contains…" className="h-8 max-w-60" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })} />;
      break;
    case 'dependency':
      body = (
        <Select aria-label="Dependency state" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
          <option value="blocked">is blocked</option>
          <option value="blocking">is blocking others</option>
          <option value="free">has no open dependencies</option>
        </Select>
      );
      break;
    case 'recurring':
    case 'subtask':
      body = (
        <Select aria-label="Yes or no" className={sel} value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as 'yes' | 'no' })}>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </Select>
      );
      break;
    default:
      if (isDate) {
        const r = rule as Extract<Rule, { field: DateField }>;
        body = (
          <>
            <Select aria-label="Comparison" className={sel} value={r.op} onChange={(e) => onChange({ ...r, op: e.target.value as typeof r.op })}>
              {Object.entries(DATE_OP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            {!['none', 'any', 'overdue'].includes(r.op) && (
              <Input list="filter-date-suggestions" aria-label="Date" placeholder="today, this-week, +7d, 2026-12-01" className="h-8 !w-44" value={r.value ?? ''} onChange={(e) => onChange({ ...r, value: e.target.value })} />
            )}
            {r.op === 'between' && <Input list="filter-date-suggestions" aria-label="End date" className="h-8 !w-36" value={r.value2 ?? ''} onChange={(e) => onChange({ ...r, value2: e.target.value })} />}
          </>
        );
      }
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-2/60 p-1.5">
      <Select aria-label="Field" className={sel} value={rule.field} onChange={(e) => onChange(defaultRule(e.target.value as Rule['field']))}>
        {Object.entries(FIELD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      {body}
      <IconButton size="sm" label="Remove condition" onClick={onRemove} className="ml-auto">
        <X size={14} />
      </IconButton>
    </div>
  );
}

export function asGroup(c: Condition): Group {
  return c.kind === 'group' ? c : { kind: 'group', op: 'and', children: [c] };
}

export function GroupEditor({ group, onChange, onRemove, depth = 0 }: { group: Group; onChange: (g: Group) => void; onRemove?: () => void; depth?: number }) {
  const setChild = (i: number, c: Condition | null) => {
    const children = [...group.children];
    if (c) children[i] = c;
    else children.splice(i, 1);
    onChange({ ...group, children });
  };
  return (
    <div className={cx('flex flex-col gap-1.5', depth > 0 && 'rounded-xl border border-line p-2')}>
      <div className="flex items-center gap-2 text-[0.85rem]">
        <span className="text-muted">Match</span>
        <Select aria-label="Match all or any" className="h-8 text-[0.85rem]" value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as 'and' | 'or' })}>
          <option value="and">all of these (AND)</option>
          <option value="or">any of these (OR)</option>
        </Select>
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={!!group.not} onChange={(e) => onChange({ ...group, not: e.target.checked })} /> exclude matches (NOT)
        </label>
        {onRemove && (
          <IconButton size="sm" label="Remove group" onClick={onRemove} className="ml-auto">
            <X size={14} />
          </IconButton>
        )}
      </div>
      {group.children.map((c, i) =>
        c.kind === 'group' ? (
          <GroupEditor key={i} group={c} depth={depth + 1} onChange={(g) => setChild(i, g)} onRemove={() => setChild(i, null)} />
        ) : c.kind === 'not' ? (
          <GroupEditor key={i} group={{ ...asGroup(c.child), not: true }} depth={depth + 1} onChange={(g) => setChild(i, g)} onRemove={() => setChild(i, null)} />
        ) : (
          <RuleEditor key={i} rule={c} onChange={(r) => setChild(i, r)} onRemove={() => setChild(i, null)} />
        ),
      )}
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, children: [...group.children, defaultRule('priority')] })}>
          <Plus size={13} /> Condition
        </Button>
        {depth < 3 && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, children: [...group.children, { kind: 'group', op: 'or', children: [defaultRule('priority')] }] })}>
            <FolderTree size={13} /> Group
          </Button>
        )}
      </div>
    </div>
  );
}

export function FilterEditorView({ id }: { id: string | null }) {
  const app = useApp();
  const act = useAction();
  const existing = useQuery(() => (id ? app.repos.filters.get(id) : undefined), [id]);
  const [name, setName] = useState(existing?.name ?? '');
  const [root, setRoot] = useState<Group>(existing?.definition ? asGroup(existing.definition.root) : { kind: 'group', op: 'and', children: [defaultRule('priority')] });
  const [text, setText] = useState(existing?.query ?? 'p1');
  const [textError, setTextError] = useState<string | null>(null);
  const [fav, setFav] = useState(existing?.isFavorite ?? false);

  // Visual → text whenever the tree changes from the builder.
  const syncText = (g: Group) => {
    setRoot(g);
    setText(app.filters.toQuery(g));
    setTextError(null);
  };
  // Text → visual on valid input.
  const onText = (q: string) => {
    setText(q);
    const r = app.filters.parse(q);
    if (r.definition) {
      setRoot(asGroup(r.definition.root));
      setTextError(null);
    } else setTextError(r.error);
  };
  useEffect(() => {
    if (existing && !name) setName(existing.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing]);

  const preview = useQuery(() => {
    try {
      return app.filters.run(root);
    } catch {
      return [];
    }
  }, [root]);
  const canSave = name.trim() && !textError && root.children.length > 0;
  const save = () => {
    const savedId = act(() => app.filters.save({ id: id ?? undefined, name, definition: { v: 1, root }, isFavorite: fav }));
    if (savedId) go({ name: 'filter', id: savedId });
  };
  const sample = useMemo(() => preview.slice(0, 50), [preview]);

  return (
    <>
      <ViewHeader
        title={id ? 'Edit filter' : 'New filter'}
        icon={<Filter size={22} className="text-p3" />}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => history.back()}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
              Save
            </Button>
          </>
        }
      />
      <ViewBody>
        <datalist id="filter-date-suggestions">
          {DATE_SUGGESTIONS.map((d) => <option key={d} value={d} />)}
        </datalist>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1 text-[0.8rem] font-medium text-muted">
              Name
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. This week’s priorities" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-[0.88rem]">
              <input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} /> Pin to sidebar
            </label>
          </div>
          <section aria-label="Conditions">
            <GroupEditor group={root} onChange={syncText} />
          </section>
          <FilterFromWords onQuery={onText} />
          <label className="flex flex-col gap-1 text-[0.8rem] font-medium text-muted">
            Advanced query (stays in sync with the builder)
            <Input value={text} onChange={(e) => onText(e.target.value)} className="font-mono text-[0.88rem]" aria-invalid={!!textError} aria-describedby="query-help" />
          </label>
          <p id="query-help" className={cx('-mt-2 text-[0.8rem]', textError ? 'text-danger' : 'text-subtle')} role={textError ? 'alert' : undefined}>
            {textError ?? 'Examples: p1 & due:this-week · #Home & deadline:this-month · (overdue | p1) & !@waiting-on · duration<15 · status:waiting · blocked'}
          </p>
          <GroupHeading title="Preview" count={preview.length}>
            <TaskList tasks={sample} tree={false} showProject ariaLabel="Filter preview" />
            {preview.length > sample.length && <p className="py-2 text-[0.85rem] text-muted">…and {preview.length - sample.length} more</p>}
            {preview.length === 0 && <p className="py-4 text-[0.88rem] text-muted">No tasks match yet.</p>}
          </GroupHeading>
        </div>
      </ViewBody>
    </>
  );
}
