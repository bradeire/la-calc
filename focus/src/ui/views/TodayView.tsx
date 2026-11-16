import { CalendarCheck, Sun } from 'lucide-react';
import { formatLongDate } from '@/core/dates';
import { useAction, useApp, useDatePrefs, useQuery, useToday } from '../hooks';
import { Button, EmptyState } from '../primitives';
import { AddTaskRow, GroupHeading, ViewBody } from '../components/common';
import { WorkloadBar } from '../components/Planning';
import { TaskList } from '../components/TaskList';
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
  const doneToday = useQuery(
    () => app.repos.tasks.listCompleted(new Date(`${today}T00:00:00`).toISOString(), new Date(`${today}T23:59:59.999`).toISOString(), 50),
    [today],
  );

  return (
    <>
      <ViewHeader
        title="Today"
        icon={<Sun size={22} className="text-ok" />}
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  act((force) =>
                    app.tasks.bulkUpdate(
                      overdue.filter((t) => t.scheduledDate).map((t) => t.id),
                      { scheduledDate: today },
                      { force },
                    ),
                  )
                }
                disabled={!overdue.some((t) => t.scheduledDate)}
              >
                Move to today
              </Button>
            }
          >
            <TaskList tasks={overdue} tree={false} showProject ariaLabel="Overdue tasks" />
          </GroupHeading>
        )}
        {overdue.length ? (
          <GroupHeading title="Today" count={rest.length}>
            <TaskList tasks={rest} tree={false} showProject hideDate draggable ariaLabel="Today’s tasks" />
            <AddTaskRow defaults={{ scheduledDate: today }} />
          </GroupHeading>
        ) : (
          <div className="mt-1">
            <TaskList tasks={rest} tree={false} showProject hideDate draggable ariaLabel="Today’s tasks" />
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
