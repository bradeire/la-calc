import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Clock, Plus, Settings2, Table2, Target, TextSearch } from 'lucide-react';
import { addDays, diffDays, formatDuration, formatNumericDate, MONTH_SHORT, startOfMonth, startOfWeek, WEEKDAY_SHORT, weekdayIndex, type ISODate } from '@/core/dates';
import { NO_GOALS, type Goals } from '@/core/goals';
import type { DateRange, Granularity } from '@/core/insights';
import { DEFAULT_INSIGHTS_LAYOUT, INSIGHT_WIDGETS, type InsightWidget, type WidgetLayout } from '@/data/repositories/settings';
import { useUi } from '@/state/ui-store';
import { errorMessage, useApp, useDatePrefs, useQuery, useSettings } from '../hooks';
import { Button, Dialog, Field, IconButton, Input, Select, Switch, cx } from '../primitives';
import { ViewHeader } from '../layout/Chrome';
import { TaskList } from '../components/TaskList';
import { BarList, ColumnChart, DataTable, Progress } from '../components/Charts';
import { go } from '../router';

export const WIDGET_TITLES: Record<InsightWidget, string> = {
  stats: 'Summary',
  goals: 'Goals and streaks',
  completion: 'Created and completed',
  today: 'Today’s tasks',
  overdue: 'Overdue',
  deadlines: 'Upcoming deadlines',
  waiting: 'Waiting on others',
  recent: 'Recently completed',
  capture: 'Quick capture',
  workload: 'Workload, next 14 days',
  byProject: 'Completed by project',
  byLabel: 'Completed by label',
  priority: 'Priority distribution',
  dueTrend: 'Due dates met and missed',
  recurring: 'Recurring tasks',
  projects: 'Project progress',
  time: 'Time tracked',
};

type Preset = 'week' | '7' | 'month' | '30' | '90' | 'year' | 'custom';
export function rangeFor(p: Preset, today: ISODate, weekStartsOn: 0 | 1): DateRange {
  switch (p) {
    case 'week': return { from: startOfWeek(today, weekStartsOn), to: addDays(startOfWeek(today, weekStartsOn), 6) };
    case 'month': return { from: startOfMonth(today), to: addDays(startOfMonth(addDays(startOfMonth(today), 32)), -1) };
    case '30': return { from: addDays(today, -29), to: today };
    case '90': return { from: addDays(today, -89), to: today };
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    default: return { from: addDays(today, -6), to: today };
  }
}

function bucketLabel(d: ISODate, g: Granularity): { short: string; long: string } {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  if (g === 'month') return { short: MONTH_SHORT[m - 1]!, long: `${MONTH_SHORT[m - 1]} ${y}` };
  if (g === 'week') return { short: `${day} ${MONTH_SHORT[m - 1]}`, long: `Week of ${day} ${MONTH_SHORT[m - 1]} ${y}` };
  return { short: `${WEEKDAY_SHORT[weekdayIndex(d)]} ${day}`, long: `${WEEKDAY_SHORT[weekdayIndex(d)]} ${day} ${MONTH_SHORT[m - 1]}` };
}

/** Merge the saved layout with the known widget list (new widgets appear, removed ones vanish). */
export function normaliseLayout(saved: readonly WidgetLayout[]): WidgetLayout[] {
  const known = saved.filter((w) => (INSIGHT_WIDGETS as readonly string[]).includes(w.id));
  const seen = new Set(known.map((w) => w.id));
  return [...known, ...DEFAULT_INSIGHTS_LAYOUT.filter((w) => !seen.has(w.id))];
}

function Card({ id, layout, children, table, note }: { id: InsightWidget; layout: WidgetLayout; children: ReactNode; table?: ReactNode; note?: string }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section aria-labelledby={`w-${id}`} className={cx('rounded-xl border border-line bg-surface p-4', layout.size === 'full' && 'lg:col-span-2')}>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`w-${id}`} className="text-[0.95rem] font-semibold">
            {WIDGET_TITLES[id]}
          </h2>
          {note && <p className="text-[0.78rem] text-muted">{note}</p>}
        </div>
        {table && (
          <IconButton size="sm" label={showTable ? `Show ${WIDGET_TITLES[id]} as chart` : `Show ${WIDGET_TITLES[id]} as table`} onClick={() => setShowTable((v) => !v)}>
            {showTable ? <BarChart3 size={15} /> : <Table2 size={15} />}
          </IconButton>
        )}
      </div>
      {showTable && table ? table : children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <div className="text-[1.4rem] font-semibold tabular-nums leading-tight">{value}</div>
      <div className="text-[0.8rem] text-muted">{label}</div>
      {hint && <div className="text-[0.72rem] text-subtle">{hint}</div>}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="py-3 text-[0.85rem] text-muted">{children}</p>;

export function InsightsView() {
  const app = useApp();
  const settings = useSettings();
  const prefs = useDatePrefs();
  const today = app.insights.today();
  const [preset, setPreset] = useState<Preset>('7');
  const [custom, setCustom] = useState<DateRange>(() => ({ from: addDays(today, -29), to: today }));
  const range = preset === 'custom' ? custom : rangeFor(preset, today, settings.weekStartsOn);
  const valid = range.from <= range.to && diffDays(range.from, range.to) <= 366 * 3;
  const report = useQuery(() => (valid ? app.insights.report(range) : null), [range.from, range.to, valid]);
  const projects = useQuery(() => new Map(app.repos.projects.list({ includeArchived: true }).map((p) => [p.id, p])), []);
  const labels = useQuery(() => new Map(app.repos.labels.list().map((l) => [l.id, l])), []);
  const layout = useMemo(() => normaliseLayout(settings.insightsLayout), [settings.insightsLayout]);
  const [customising, setCustomising] = useState(false);
  const [editingGoals, setEditingGoals] = useState(false);
  const ui = useUi();
  const projectName = (id: string | null) => (id ? (projects.get(id)?.name ?? 'Deleted project') : 'Inbox');
  const labelName = (id: string | null) => (id ? `@${labels.get(id)?.name ?? 'deleted'}` : 'No label');

  const render = (w: WidgetLayout): ReactNode => {
    if (!report) return null;
    const g = report.granularity;
    const bl = (d: ISODate) => bucketLabel(d, g);
    switch (w.id) {
      case 'stats': {
        const t = report.totals;
        return (
          <Card key={w.id} id={w.id} layout={w} note="Completed and created count only this period; open and overdue are as of now.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Completed" value={t.completed} hint={`${t.completedPerDay} a day`} />
              <Stat label="Created" value={t.created} />
              <Stat label="Open now" value={t.open} />
              <Stat label="Overdue now" value={t.overdue} />
              <Stat label="Time tracked" value={formatDuration(report.time.totalMinutes)} />
            </div>
          </Card>
        );
      }
      case 'completion': {
        const pts = report.createdVsCompleted;
        const series = [
          { name: 'Completed', color: 'var(--viz-1)', values: pts.map((p) => p.completed) },
          { name: 'Created', color: 'var(--viz-2)', values: pts.map((p) => p.created) },
        ];
        return (
          <Card
            key={w.id}
            id={w.id}
            layout={w}
            note={`Per ${g}. Each repeat of a recurring task counts once.`}
            table={<DataTable caption="Created and completed" columns={['Period', 'Completed', 'Created']} rows={pts.map((p) => [bl(p.bucket).long, p.completed, p.created])} />}
          >
            <ColumnChart ariaLabel="Created and completed tasks per period" labels={pts.map((p) => bl(p.bucket).short)} longLabels={pts.map((p) => bl(p.bucket).long)} series={series} />
          </Card>
        );
      }
      case 'dueTrend': {
        const pts = report.dueTrend;
        return (
          <Card
            key={w.id}
            id={w.id}
            layout={w}
            note="Tasks due in each period (deadline, else scheduled date) and whether they were done by that day."
            table={<DataTable caption="Due dates" columns={['Period', 'Due', 'On time', 'Missed']} rows={pts.map((p) => [bl(p.bucket).long, p.due, p.onTime, p.missed])} />}
          >
            <ColumnChart
              stacked
              ariaLabel="Due dates met and missed per period"
              labels={pts.map((p) => bl(p.bucket).short)}
              longLabels={pts.map((p) => bl(p.bucket).long)}
              series={[
                { name: 'On time', color: 'var(--viz-1)', values: pts.map((p) => p.onTime) },
                { name: 'Missed', color: 'var(--viz-2)', values: pts.map((p) => p.missed) },
              ]}
            />
          </Card>
        );
      }
      case 'byProject':
      case 'byLabel': {
        const rows = (w.id === 'byProject' ? report.byProject : report.byLabel).slice(0, 10);
        const name = w.id === 'byProject' ? projectName : labelName;
        return (
          <Card key={w.id} id={w.id} layout={w} table={rows.length ? <DataTable caption={WIDGET_TITLES[w.id]} columns={['Name', 'Completed']} rows={rows.map((r) => [name(r.key), r.count])} /> : undefined}>
            {rows.length ? <BarList ariaLabel={WIDGET_TITLES[w.id]} rows={rows.map((r) => ({ key: String(r.key), label: name(r.key), value: r.count }))} /> : <Empty>Nothing completed in this period.</Empty>}
          </Card>
        );
      }
      case 'priority':
        return (
          <Card key={w.id} id={w.id} layout={w} note="Open tasks now, and tasks completed in this period.">
            <DataTable
              caption="Priority distribution"
              columns={['Priority', 'Open', 'Completed']}
              rows={report.priority.map((p) => [
                <span key="p" className="flex items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--p${p.priority})` }} />
                  {p.priority === 4 ? 'P4 (none)' : `P${p.priority}`}
                </span>,
                p.open,
                p.completed,
              ])}
            />
          </Card>
        );
      case 'workload': {
        const days = report.workload;
        return (
          <Card
            key={w.id}
            id={w.id}
            layout={w}
            note={`Planned minutes per day from estimates (tasks without one count as ${settings.defaultEstimate} min), against your working hours.`}
            table={<DataTable caption="Workload" columns={['Day', 'Planned', 'Capacity']} rows={days.map((d) => [formatNumericDate(d.date, prefs), formatDuration(d.planned), formatDuration(d.capacity)])} />}
          >
            <ColumnChart
              ariaLabel="Planned and available minutes per day"
              labels={days.map((d) => bucketLabel(d.date, 'day').short)}
              longLabels={days.map((d) => bucketLabel(d.date, 'day').long)}
              format={(n) => formatDuration(n)}
              series={[{ name: 'Planned', color: 'var(--viz-1)', values: days.map((d) => d.planned) }]}
              marker={{ name: 'Working hours', values: days.map((d) => d.capacity) }}
            />
          </Card>
        );
      }
      case 'recurring': {
        const rows = report.recurring;
        return (
          <Card key={w.id} id={w.id} layout={w} note="Completed repeats against how many the pattern called for. “After completion” repeats have no fixed expectation.">
            {rows.length ? (
              <DataTable caption="Recurring tasks" columns={['Task', 'Done', 'Expected', 'Rate']} rows={rows.map((r) => [r.title, r.completed, r.expected ?? '—', r.expected ? `${Math.round(Math.min(1, r.completed / r.expected) * 100)}%` : '—'])} />
            ) : (
              <Empty>No recurring tasks in this period.</Empty>
            )}
          </Card>
        );
      }
      case 'projects': {
        const rows = report.projects.filter((p) => p.projectId && projects.get(p.projectId) && !projects.get(p.projectId)!.archivedAt).sort((a, b) => projectName(a.projectId).localeCompare(projectName(b.projectId)));
        return (
          <Card key={w.id} id={w.id} layout={w} note="All tasks and subtasks, as of now.">
            {rows.length ? (
              <ul className="flex flex-col gap-2">
                {rows.map((p) => (
                  <li key={p.projectId}>
                    <button type="button" className="mb-1 flex w-full justify-between text-left text-[0.85rem] hover:underline" onClick={() => go({ name: 'project', id: p.projectId! })}>
                      <span className="truncate">{projectName(p.projectId)}</span>
                      <span className="text-muted tabular-nums">
                        {p.completed}/{p.completed + p.open}
                      </span>
                    </button>
                    <Progress value={p.completed} max={p.completed + p.open} label={`${projectName(p.projectId)} progress`} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No projects yet.</Empty>
            )}
          </Card>
        );
      }
      case 'time': {
        const t = report.time;
        return (
          <Card
            key={w.id}
            id={w.id}
            layout={w}
            note="Finished timers and manual entries. A timer that is still running is shown separately: it isn’t counted as worked time."
            table={<DataTable caption="Time per day" columns={['Day', 'Time']} rows={t.byDay.map((d) => [formatNumericDate(d.day, prefs), formatDuration(d.minutes)])} />}
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.85rem]">
              <span>
                Total <strong className="tabular-nums">{formatDuration(t.totalMinutes)}</strong>
              </span>
              {t.runningMinutes > 0 && <span className="text-muted">Running timer: {formatDuration(t.runningMinutes)} (not counted)</span>}
              <Button size="sm" variant="ghost" onClick={() => go({ name: 'timeLog' })}>
                <Clock size={14} /> Time log
              </Button>
            </div>
            {t.totalMinutes > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {t.byDay.length <= 62 ? (
                  <ColumnChart ariaLabel="Time tracked per day" labels={t.byDay.map((d) => bucketLabel(d.day, 'day').short)} longLabels={t.byDay.map((d) => bucketLabel(d.day, 'day').long)} format={formatDuration} series={[{ name: 'Time', color: 'var(--viz-1)', values: t.byDay.map((d) => d.minutes) }]} />
                ) : (
                  <ColumnChart ariaLabel="Time tracked per week" labels={t.byWeek.map((d) => bucketLabel(d.week, 'week').short)} longLabels={t.byWeek.map((d) => bucketLabel(d.week, 'week').long)} format={formatDuration} series={[{ name: 'Time', color: 'var(--viz-1)', values: t.byWeek.map((d) => d.minutes) }]} />
                )}
                <div>
                  <h3 className="mb-2 text-[0.85rem] font-medium text-muted">By project</h3>
                  <BarList ariaLabel="Time by project" format={formatDuration} rows={t.byProject.slice(0, 8).map((p) => ({ key: String(p.projectId), label: projectName(p.projectId), value: p.minutes }))} />
                  {t.estimateVsActual.length > 0 && (
                    <>
                      <h3 className="mt-4 mb-1 text-[0.85rem] font-medium text-muted">Estimate and actual (completed tasks)</h3>
                      <DataTable
                        caption="Estimate and actual"
                        columns={['Task', 'Estimate', 'Actual']}
                        rows={t.estimateVsActual.slice(0, 6).map((e) => [app.repos.tasks.get(e.taskId)?.title ?? '—', formatDuration(e.estimate), formatDuration(e.actual)])}
                      />
                    </>
                  )}
                </div>
              </div>
            ) : (
              <Empty>No time tracked in this period. Start a timer in Focus mode or add time in a task’s details.</Empty>
            )}
          </Card>
        );
      }
      case 'goals':
        return <GoalsCard key={w.id} layout={w} status={report.goals} onEdit={() => setEditingGoals(true)} />;
      case 'capture':
        return (
          <Card key={w.id} id={w.id} layout={w}>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => ui.openQuickAdd()}>
                <Plus size={15} /> Add task
              </Button>
              <Button onClick={() => ui.openCapture()}>
                <TextSearch size={15} /> Capture from text
              </Button>
            </div>
          </Card>
        );
      default: {
        const list = report.lists[w.id as 'today' | 'overdue' | 'deadlines' | 'waiting' | 'recent'];
        return (
          <Card key={w.id} id={w.id} layout={w}>
            {list.length ? <TaskList tasks={list} tree={false} showProject ariaLabel={WIDGET_TITLES[w.id]} /> : <Empty>Nothing here.</Empty>}
          </Card>
        );
      }
    }
  };

  return (
    <>
      <ViewHeader
        wide
        title="Insights"
        icon={<BarChart3 size={22} className="text-accent" />}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setCustomising(true)}>
            <Settings2 size={15} /> Customise
          </Button>
        }
      />
      <div className="mx-auto max-w-5xl px-4 pb-16 lg:px-8">
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Period" htmlFor="insights-range">
            <Select id="insights-range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="7">Last 7 days</option>
              <option value="week">This week</option>
              <option value="30">Last 30 days</option>
              <option value="month">This month</option>
              <option value="90">Last 90 days</option>
              <option value="year">This year</option>
              <option value="custom">Custom…</option>
            </Select>
          </Field>
          {preset === 'custom' && (
            <>
              <Field label="From" htmlFor="insights-from">
                <Input id="insights-from" type="date" value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
              </Field>
              <Field label="To" htmlFor="insights-to">
                <Input id="insights-to" type="date" value={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
              </Field>
            </>
          )}
          <p className="pb-2 text-[0.8rem] text-muted">
            {formatNumericDate(range.from, prefs)} – {formatNumericDate(range.to, prefs)}
          </p>
        </div>
        {!valid ? (
          <p role="alert" className="text-danger">
            Choose a start date before the end date (up to three years).
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">{layout.filter((w) => !w.hidden).map(render)}</div>
        )}
        {layout.every((w) => w.hidden) && <Empty>All widgets are hidden. Use Customise to show some.</Empty>}
      </div>
      <CustomiseDialog open={customising} onClose={() => setCustomising(false)} layout={layout} />
      <GoalsDialog open={editingGoals} onClose={() => setEditingGoals(false)} goals={settings.goals} />
    </>
  );
}

function GoalsCard({ layout, status, onEdit }: { layout: WidgetLayout; status: ReturnType<ReturnType<typeof useApp>['insights']['goalStatus']>; onEdit: () => void }) {
  const g = status.goals;
  const any = g.dailyTasks !== null || g.weeklyTasks !== null || g.dailyMinutes !== null || g.weeklyMinutes !== null;
  const row = (label: string, value: number, target: number | null, fmt: (n: number) => string = String) =>
    target === null ? null : (
      <div key={label}>
        <div className="mb-1 flex justify-between text-[0.85rem]">
          <span>{label}</span>
          <span className="tabular-nums text-muted">
            {fmt(value)} of {fmt(target)}
          </span>
        </div>
        <Progress value={value} max={target} label={label} />
      </div>
    );
  return (
    <Card id="goals" layout={layout} note="Targets are optional. Non-working days don’t break a daily streak unless you choose otherwise.">
      {!any ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[0.85rem] text-muted">Set a daily or weekly target to see progress and streaks here.</p>
          <Button size="sm" onClick={onEdit}>
            <Target size={14} /> Set goals
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {row('Tasks today', status.today.completed, g.dailyTasks)}
          {row('Time today', status.today.minutes, g.dailyMinutes, formatDuration)}
          {row('Tasks this week', status.week.completed, g.weeklyTasks)}
          {row('Time this week', status.week.minutes, g.weeklyMinutes, formatDuration)}
          <dl className="grid grid-cols-2 gap-2 text-[0.85rem]">
            {(g.dailyTasks !== null || g.dailyMinutes !== null) && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-muted">Daily streak</dt>
                <dd className="tabular-nums">
                  {status.daily.current} {status.daily.current === 1 ? 'day' : 'days'} <span className="text-subtle">· best {status.daily.best}</span>
                </dd>
              </div>
            )}
            {(g.weeklyTasks !== null || g.weeklyMinutes !== null) && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-muted">Weekly streak</dt>
                <dd className="tabular-nums">
                  {status.weekly.current} {status.weekly.current === 1 ? 'week' : 'weeks'} <span className="text-subtle">· best {status.weekly.best}</span>
                </dd>
              </div>
            )}
          </dl>
          <details className="text-[0.85rem]">
            <summary className="cursor-pointer text-muted">Last 12 weeks</summary>
            <DataTable
              caption="Last 12 weeks"
              columns={['Week of', 'Completed', 'Time', 'Weekly target']}
              rows={status.history.map((h) => [h.week, h.completed, formatDuration(h.minutes), h.met === null ? '—' : h.met ? 'Met' : 'Not met'])}
            />
          </details>
          <Button size="sm" variant="ghost" className="self-start" onClick={onEdit}>
            <Target size={14} /> Edit goals
          </Button>
        </div>
      )}
    </Card>
  );
}

function GoalsDialog({ open, onClose, goals }: { open: boolean; onClose: () => void; goals: Goals }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const [draft, setDraft] = useState<Record<keyof Omit<Goals, 'skipNonWorkingDays'>, string>>(() => ({
    dailyTasks: goals.dailyTasks?.toString() ?? '',
    weeklyTasks: goals.weeklyTasks?.toString() ?? '',
    dailyMinutes: goals.dailyMinutes?.toString() ?? '',
    weeklyMinutes: goals.weeklyMinutes?.toString() ?? '',
  }));
  const [skip, setSkip] = useState(goals.skipNonWorkingDays);
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = () => {
    try {
      app.insights.setGoals({ dailyTasks: num(draft.dailyTasks), weeklyTasks: num(draft.weeklyTasks), dailyMinutes: num(draft.dailyMinutes), weeklyMinutes: num(draft.weeklyMinutes), skipNonWorkingDays: skip });
      pushToast({ message: 'Goals saved', tone: 'success' });
      onClose();
    } catch {
      pushToast({ message: 'Use whole numbers from 1 upwards, or leave a target empty', tone: 'error' });
    }
  };
  const field = (k: keyof typeof draft, label: string) => (
    <Field label={label} htmlFor={`goal-${k}`}>
      <Input id={`goal-${k}`} type="number" inputMode="numeric" min={1} value={draft[k]} placeholder="No target" onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Goals"
      footer={
        <>
          <Button variant="ghost" onClick={() => (app.insights.setGoals(NO_GOALS), onClose())}>
            Clear all
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {field('dailyTasks', 'Tasks per day')}
        {field('weeklyTasks', 'Tasks per week')}
        {field('dailyMinutes', 'Tracked minutes per day')}
        {field('weeklyMinutes', 'Tracked minutes per week')}
        <label className="flex items-center justify-between gap-3 text-[0.9rem] sm:col-span-2">
          <span>Non-working days don’t break a daily streak</span>
          <Switch checked={skip} onChange={setSkip} label="Non-working days don’t break a daily streak" />
        </label>
      </div>
    </Dialog>
  );
}

function CustomiseDialog({ open, onClose, layout }: { open: boolean; onClose: () => void; layout: WidgetLayout[] }) {
  const app = useApp();
  const pushToast = useUi((s) => s.pushToast);
  const save = (next: WidgetLayout[]) => {
    try {
      app.repos.settings.set('insightsLayout', next);
    } catch (err) {
      pushToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...layout];
    const [w] = next.splice(i, 1);
    next.splice(i + d, 0, w!);
    save(next);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Customise Insights" footer={<>
      <Button variant="ghost" onClick={() => save(DEFAULT_INSIGHTS_LAYOUT)}>Reset</Button>
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>}>
      <ul className="divide-y divide-line px-4">
        {layout.map((w, i) => (
          <li key={w.id} className="flex items-center gap-2 py-2">
            <Switch checked={!w.hidden} onChange={(v) => save(layout.map((x) => (x.id === w.id ? { ...x, hidden: !v } : x)))} label={`Show ${WIDGET_TITLES[w.id]}`} />
            <span className={cx('min-w-0 flex-1 truncate text-[0.9rem]', w.hidden && 'text-muted')}>{WIDGET_TITLES[w.id]}</span>
            <Select aria-label={`${WIDGET_TITLES[w.id]} width`} value={w.size} onChange={(e) => save(layout.map((x) => (x.id === w.id ? { ...x, size: e.target.value as 'half' | 'full' } : x)))} className="w-auto">
              <option value="half">Half</option>
              <option value="full">Full</option>
            </Select>
            <IconButton size="sm" label={`Move ${WIDGET_TITLES[w.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={15} />
            </IconButton>
            <IconButton size="sm" label={`Move ${WIDGET_TITLES[w.id]} down`} disabled={i === layout.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={15} />
            </IconButton>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

