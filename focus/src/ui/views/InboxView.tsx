import { ClipboardPaste, Inbox } from 'lucide-react';
import { useUi } from '@/state/ui-store';
import { useApp, useQuery } from '../hooks';
import { Button, EmptyState } from '../primitives';
import { AddTaskRow, ViewBody } from '../components/common';
import { TaskList } from '../components/TaskList';
import { ViewHeader } from '../layout/Chrome';

export function InboxView() {
  const app = useApp();
  const tasks = useQuery(() => app.repos.tasks.listInbox(), []);
  const openCapture = useUi((s) => s.openCapture);
  const top = tasks.filter((t) => !t.parentId).length;
  return (
    <>
      <ViewHeader
        title="Inbox"
        icon={<Inbox size={22} className="text-p3" />}
        subtitle={top ? `${top} to process` : undefined}
        actions={
          <Button size="sm" variant="ghost" onClick={() => openCapture()}>
            <ClipboardPaste size={14} /> Capture from text
          </Button>
        }
      />
      <ViewBody>
        <TaskList tasks={tasks} reorderable ariaLabel="Inbox tasks" />
        <AddTaskRow />
        {tasks.length === 0 && (
          <EmptyState
            icon={<Inbox size={26} />}
            title="Your Inbox is clear"
            body={
              <>
                Capture anything here with Quick Add, then move it into a project, give it a date, or both. Try “Buy batteries tomorrow p2”.
              </>
            }
          />
        )}
      </ViewBody>
    </>
  );
}
