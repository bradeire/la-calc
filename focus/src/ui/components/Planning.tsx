import { useMemo, useState } from 'react';
import { ArrowRight, Check, CircleAlert, X } from 'lucide-react';
import { formatDuration, formatRelativeDate } from '@/core/dates';
import type { Conflict, DayLoad, Suggestion } from '@/core/scheduling';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { go, openTask } from '../router';
import { Button, Dialog, cx } from '../primitives';
import { PlanReviewButton } from './AiFeatures';

/** Planned minutes against working capacity for one day. */
export function WorkloadBar({ load, compact }: { load: DayLoad; compact?: boolean }) {
  if (!load.taskIds.length && load.capacity === 0) return null;
  const pct = load.capacity ? Math.min(100, (load.planned / load.capacity) * 100) : 100;
  const over = load.planned > load.capacity;
  const label = `${formatDuration(Math.round(load.planned))} planned of ${formatDuration(load.capacity)} available${load.unestimated ? ` (${load.unestimated} without estimates)` : ''}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-normal" title={label}>
      <span
        className={cx('h-1.5 overflow-hidden rounded-full bg-surface-3', compact ? 'w-10' : 'w-16')}
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(load.planned)}
        aria-valuemin={0}
        aria-valuemax={Math.max(load.capacity, 1)}
      >
        <span className={cx('block h-full rounded-full', over ? 'bg-danger' : pct > 85 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
      </span>
      <span className={over ? 'text-danger' : 'text-muted'}>
        {formatDuration(Math.round(load.planned))}
        {!compact && ` / ${formatDuration(load.capacity)}`}
      </span>
    </span>
  );
}

let rejectedThisSession = new Set<string>();

export function usePlan() {
  const app = useApp();
  const conflicts = useQuery(() => app.planning.conflicts(), []);
  const [rejected, setRejected] = useState(rejectedThisSession);
  const suggestions = useQuery(() => app.planning.suggestions(), []).filter((s) => !rejected.has(s.key));
  const reject = (key: string) => {
    rejectedThisSession = new Set([...rejectedThisSession, key]);
    setRejected(rejectedThisSession);
  };
  const problems = conflicts.filter((c) => c.kind !== 'overdue').length + (conflicts.some((c) => c.kind === 'overdue') ? 1 : 0);
  return { conflicts, suggestions, reject, attention: problems + suggestions.length };
}

/** Review conflicts and accept or reject suggested moves. Nothing changes without the user's say-so. */
export function PlanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const { conflicts, suggestions, reject } = usePlan();
  const titles = useQuery(() => new Map(app.repos.tasks.listForFilters().map((t) => [t.id, t.title])), []);
  const name = (id: string) => titles.get(id) ?? 'A task';
  const d = (x: string | null) => (x ? formatRelativeDate(x, today, prefs) : 'unscheduled');
  const describe = (c: Conflict): { text: string; taskId?: string } => {
    switch (c.kind) {
      case 'overdue': return { text: `${c.taskIds.length} overdue task${c.taskIds.length > 1 ? 's' : ''} (${formatDuration(c.minutes)} of work)` };
      case 'overloaded': return { text: `${d(c.date)} is over capacity: ${formatDuration(Math.round(c.planned))} planned, ${formatDuration(c.capacity)} available` };
      case 'overlap': return { text: `“${name(c.taskIds[0])}” overlaps “${name(c.taskIds[1])}” on ${d(c.date)}`, taskId: c.taskIds[1] };
      case 'afterDeadline': return { text: `“${name(c.taskId)}” is scheduled after its deadline`, taskId: c.taskId };
      case 'beforeStart': return { text: `“${name(c.taskId)}” is scheduled before its start date`, taskId: c.taskId };
      case 'dependencyOrder': return { text: `“${name(c.taskId)}” is planned before “${name(c.prerequisiteId)}”, which it depends on`, taskId: c.taskId };
      case 'eventClash': return { text: `“${name(c.taskId)}” is scheduled during “${c.eventTitle}” in your calendar`, taskId: c.taskId };
      case 'deadlineAtRisk': return { text: `“${name(c.taskId)}” may miss its deadline: ${formatDuration(c.needed)} of work, ${formatDuration(c.available)} available`, taskId: c.taskId };
    }
  };
  const sorted = useMemo(() => [...suggestions].sort((a, b) => a.to.localeCompare(b.to)), [suggestions]);
  const accept = (list: Suggestion[]) => act((force) => app.planning.accept(list, { force }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Review plan"
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!sorted.length} onClick={() => accept(sorted)}>
            Accept all suggestions
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 p-4">
        <section>
          <h3 className="mb-2 text-[0.9rem] font-semibold">Issues</h3>
          {conflicts.length === 0 ? (
            <p className="text-[0.88rem] text-muted">No conflicts in the next three weeks.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {conflicts.map((c, i) => {
                const x = describe(c);
                return (
                  <li key={i} className="flex items-start gap-2 text-[0.88rem]">
                    <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                    {x.taskId ? (
                      <button type="button" className="text-left hover:underline" onClick={() => (onClose(), openTask(x.taskId!))}>
                        {x.text}
                      </button>
                    ) : (
                      <span>{x.text}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-1 text-[0.9rem] font-semibold">Suggested moves</h3>
          <p className="mb-2 text-[0.8rem] text-muted">Based on priority, deadlines, start dates, dependencies and your working hours (Settings). Fixed-time tasks are never moved.</p>
          {sorted.length === 0 ? (
            <p className="text-[0.88rem] text-muted">Nothing to suggest.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
              {sorted.map((s) => (
                <li key={s.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[0.88rem]">
                  <div className="min-w-0 flex-1">
                    <button type="button" className="font-medium hover:underline" onClick={() => (onClose(), openTask(s.taskId))}>
                      {name(s.taskId)}
                    </button>
                    <div className="flex items-center gap-1 text-[0.8rem] text-muted">
                      {d(s.from)} <ArrowRight size={12} aria-label="to" /> <strong className="text-fg">{d(s.to)}</strong> · {s.reason}
                    </div>
                  </div>
                  <Button size="sm" variant="primary" onClick={() => accept([s])}>
                    <Check size={13} /> Accept
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => reject(s.key)}>
                    <X size={13} /> Reject
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <PlanReviewButton />
        <button type="button" className="self-start text-[0.8rem] text-muted underline" onClick={() => (onClose(), go({ name: 'settings' }))}>
          Change working hours or default estimate
        </button>
      </div>
    </Dialog>
  );
}
