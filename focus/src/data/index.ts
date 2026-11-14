import type { DatabaseDriver } from './db/driver';
import { ActivityRepository, AttachmentRepository, CommentRepository, ReminderRepository, TimeEntryRepository } from './repositories/content';
import { LabelRepository } from './repositories/labels';
import { ProjectRepository } from './repositories/projects';
import { SettingsRepository } from './repositories/settings';
import { TaskRepository } from './repositories/tasks';

export interface Repositories {
  db: DatabaseDriver;
  tasks: TaskRepository;
  projects: ProjectRepository;
  labels: LabelRepository;
  comments: CommentRepository;
  attachments: AttachmentRepository;
  reminders: ReminderRepository;
  activity: ActivityRepository;
  time: TimeEntryRepository;
  settings: SettingsRepository;
}

export function createRepositories(db: DatabaseDriver): Repositories {
  return {
    db,
    tasks: new TaskRepository(db),
    projects: new ProjectRepository(db),
    labels: new LabelRepository(db),
    comments: new CommentRepository(db),
    attachments: new AttachmentRepository(db),
    reminders: new ReminderRepository(db),
    activity: new ActivityRepository(db),
    time: new TimeEntryRepository(db),
    settings: new SettingsRepository(db),
  };
}
