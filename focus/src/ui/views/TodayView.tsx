import { CalendarCheck, CalendarDays, Sun } from 'lucide-react';
import type { Task } from '@/core/domain/types';
import { formatLongDate } from '@/core/dates';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { Button, EmptyState } from '../primitives';
import { AddTaskRow, GroupHeading, ViewBody } from '../components/common';
import { WorkloadBar } from '../components/Planning';
import { TaskList } from '../components/TaskList';
import { DatePopover, usePopover } from '../components/pickers';
import { OrganisedTaskList, ViewOptionsButton, useSortedTasks } from '../components/ViewOptions';
import { ViewHeader } from '../layout/Chrome';

export function TodayView() {
  const app = useApp();
  const act = useAction();
  const today = useToday();
  const prefs = useDatePrefs();
  const tasks = useQuery(() => app.repos.tasks.listToday(today), [today]);
  const load = useQuery(() => app.planning.workload(today, today)[0], [today]);
  const overdue = tasks.filter((t) => (t.scheduledDate && t.scheduledDate < today) || (!t.scheduledDate && t.deadline && t.deadline < today));
  const rest = tasks.filter((t) => !overdue.includes(t));
  const overdueSorted = useSortedTasks('today', overdue);
  const reschedulePop = usePopover();
  /** Move every overdue date (scheduled date and/or deadline) of the overdue tasks to `day`. */
  const moveOverdue = (day: string) =>
    act((force) =>
      app.repos.db.transaction(() => {
        const undo: (() => void)[] = [];
        for (const t of overdue as Task[]) {
          const patch: { scheduledDate?: string; deadline?: string } = {};
          if (t.scheduledDate && t.scheduledDate < today) patch.scheduledDate = day;
          if (t.deadline && t.deadline < today) patch.deadline = day;
          if (patch.scheduledDate || patch.deadline) undo.push(app.tasks.bulkUpdate([t.id], patch, { force }).undo);
        }
        return { label: `${undo.length} overdue task${undo.length === 1 ? '' : 's'} moved`, undo: () => app.repos.db.transaction(() => undo.reverse().forEach((u) => u())) };
      }),
    );
  const doneToday = useQuery(
    () => app.repos.tasks.listCompleted(new Date(`${today}T00:00:00`).toISOString(), new Date(`${today}T23:59:59.999`).toISOString(), 50),
    [today],
  );

  return (
    <>
      <ViewHeader
        title="Today"
        icon={<Sun size={22} className="text-ok" />}
        actions={<ViewOptionsButton viewId="today" groups={['none', 'project', 'label', 'priority', 'deadline', 'status']} />}
        subtitle={
          <span className="inline-flex items-center gap-2">
            {formatLongDate(today, prefs)}
            {load && load.taskIds.length > 0 && <WorkloadBar load={load} />}
          </span>
        }
      />
      <ViewBody>
        {overdue.length > 0 && (
          <GroupHeading
            title="Overdue"
            count={overdue.length}
            tone="danger"
            collapsible
            actions={
              <span className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => moveOverdue(today)}>
                  Move to today
                </Button>
                <Button size="sm" variant="ghost" ref={reschedulePop.ref} onClick={reschedulePop.toggle} aria-label="Reschedule overdue tasks">
                  <CalendarDays size={14} /> Reschedule…
                </Button>
                <DatePopover anchor={reschedulePop.ref} open={reschedulePop.open} onClose={reschedulePop.hide} title="Reschedule overdue" value={null} onChange={(d) => d && moveOverdue(d)} />
              </span>
            }
          >
            <TaskList tasks={overdueSorted} tree={false} showProject ariaLabel="Overdue tasks" />
          </GroupHeading>
        )}
        {overdue.length ? (
          <GroupHeading title="Today" count={rest.length}>
            <OrganisedTaskList viewId="today" tasks={rest} tree={false} showProject hideDate draggable ariaLabel="Today’s tasks" />
            <AddTaskRow defaults={{ scheduledDate: today }} />
          </GroupHeading>
        ) : (
          <div className="mt-1">
            <OrganisedTaskList viewId="today" tasks={rest} tree={false} showProject hideDate draggable ariaLabel="Today’s tasks" />
            <AddTaskRow defaults={{ scheduledDate: today }} />
          </div>
        )}
        {tasks.length === 0 && (
          <EmptyState
            icon={<CalendarCheck size={26} />}
            title={doneToday.length ? 'All clear for today' : 'Nothing planned for today'}
            body={
              doneToday.length
                ? `You completed ${doneToday.length} task${doneToday.length > 1 ? 's' : ''} today.`
                : 'Schedule tasks for today, or pin an undated task to Today from its details.'
            }
          />
        )}
        {doneToday.length > 0 && (
          <GroupHeading title="Completed today" count={doneToday.length} collapsible defaultOpen={false}>
            <TaskList tasks={doneToday} tree={false} showProject ariaLabel="Completed today" />
          </GroupHeading>
        )}
      </ViewBody>
    </>
  );
}
