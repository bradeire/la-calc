import { z } from 'zod';
import type { RecurrenceRule } from '../recurrence/types';

/** ISO calendar date, floating local (YYYY-MM-DD). See ADR-004. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
/** Local wall-clock time (HH:mm, 24-hour). */
export const isoTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #RRGGBB colour');

export const TASK_STATUSES = ['inbox', 'active', 'in_progress', 'waiting', 'completed', 'cancelled', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: readonly TaskStatus[] = ['inbox', 'active', 'in_progress', 'waiting'];
export const isOpenStatus = (s: TaskStatus) => OPEN_STATUSES.includes(s);

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  active: 'Active',
  in_progress: 'In progress',
  waiting: 'Waiting',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

export type Priority = 1 | 2 | 3 | 4;
export const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const PROJECT_LAYOUTS = ['list', 'board', 'table', 'calendar'] as const;
export type ProjectLayout = (typeof PROJECT_LAYOUTS)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  projectId: string | null;
  sectionId: string | null;
  parentId: string | null;
  priority: Priority;
  status: TaskStatus;
  startDate: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  deadline: string | null;
  durationMinutes: number | null;
  actualMinutes: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sortOrder: number;
  /** Undated task the user explicitly wants on Today. */
  pinnedToday: boolean;
  collapsed: boolean;
  seriesId: string | null;
  recurrence: RecurrenceRule | null;
  recurrenceText: string | null;
  labelIds: string[];
  isSample: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  notes: string;
  color: string;
  icon: string;
  parentId: string | null;
  layout: ProjectLayout;
  isFavorite: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sortOrder: number;
  collapsed: boolean;
  isSample: boolean;
}

export interface Section {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  isFavorite: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isSample: boolean;
}

export interface Comment {
  id: string;
  taskId: string | null;
  projectId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Attachment {
  id: string;
  taskId: string | null;
  projectId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  createdAt: string;
  deletedAt: string | null;
}

export type ReminderKind = 'absolute' | 'relative';
export interface Reminder {
  id: string;
  taskId: string;
  kind: ReminderKind;
  /** absolute: UTC ISO instant. */
  remindAt: string | null;
  /** relative: minutes before the scheduled date/time (or deadline when unscheduled). */
  offsetMinutes: number | null;
  createdAt: string;
  deliveredAt: string | null;
  dismissedAt: string | null;
  /** When snoozed, the reminder fires again at this instant (UTC ISO). */
  snoozedUntil: string | null;
}

export interface ActivityEntry {
  id: string;
  entityType: 'task' | 'project' | 'label' | 'section';
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TimeEntry {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
  note: string;
  source: 'timer' | 'manual';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ---------------------------------------------------------------------------
// Input schemas — validate everything coming from the UI or from imports.
// ---------------------------------------------------------------------------

/**
 * Field validators without defaults. NB: in Zod 4, `.partial()` still applies
 * `.default()` values, so patch schemas must be built from these bare fields or
 * every partial update would silently reset unspecified fields.
 */
const taskFields = {
  title: z.string().trim().min(1, 'A task needs a title').max(500, 'Title is too long (500 characters max)'),
  description: z.string().max(20000, 'Description is too long'),
  projectId: z.string().uuid().nullable(),
  sectionId: z.string().uuid().nullable(),
  parentId: z.string().uuid().nullable(),
  priority,
  status: z.enum(TASK_STATUSES),
  startDate: isoDate.nullable(),
  scheduledDate: isoDate.nullable(),
  scheduledTime: isoTime.nullable(),
  deadline: isoDate.nullable(),
  durationMinutes: z.number().int().positive('Duration must be positive').max(60 * 24 * 30).nullable(),
  labelIds: z.array(z.string().uuid()),
  pinnedToday: z.boolean(),
  recurrence: z.custom<RecurrenceRule>().nullable(),
  recurrenceText: z.string().nullable(),
};

export const taskInputSchema = z.object({
  title: taskFields.title,
  description: taskFields.description.default(''),
  projectId: taskFields.projectId.default(null),
  sectionId: taskFields.sectionId.default(null),
  parentId: taskFields.parentId.default(null),
  priority: taskFields.priority.default(4),
  status: taskFields.status.optional(),
  startDate: taskFields.startDate.default(null),
  scheduledDate: taskFields.scheduledDate.default(null),
  scheduledTime: taskFields.scheduledTime.default(null),
  deadline: taskFields.deadline.default(null),
  durationMinutes: taskFields.durationMinutes.default(null),
  labelIds: taskFields.labelIds.default([]),
  pinnedToday: taskFields.pinnedToday.default(false),
  recurrence: taskFields.recurrence.default(null),
  recurrenceText: taskFields.recurrenceText.default(null),
});
export type TaskInput = z.input<typeof taskInputSchema>;

export const taskPatchSchema = z.object({ ...taskFields, collapsed: z.boolean(), sortOrder: z.number() }).partial();
export type TaskPatch = z.input<typeof taskPatchSchema>;

const projectFields = {
  name: z.string().trim().min(1, 'A project needs a name').max(120, 'Project names are limited to 120 characters'),
  description: z.string().max(5000),
  notes: z.string().max(50000),
  color: hexColor,
  icon: z.string().max(40),
  parentId: z.string().uuid().nullable(),
  layout: z.enum(PROJECT_LAYOUTS),
  isFavorite: z.boolean(),
};
export const projectInputSchema = z.object({
  name: projectFields.name,
  description: projectFields.description.default(''),
  notes: projectFields.notes.default(''),
  color: projectFields.color.default('#64748b'),
  icon: projectFields.icon.default('folder'),
  parentId: projectFields.parentId.default(null),
  layout: projectFields.layout.default('list'),
  isFavorite: projectFields.isFavorite.default(false),
});
export type ProjectInput = z.input<typeof projectInputSchema>;
export const projectPatchSchema = z.object(projectFields).partial();

const labelFields = {
  name: z
    .string()
    .trim()
    .min(1, 'A label needs a name')
    .max(60, 'Label names are limited to 60 characters')
    .regex(/^[^\s@#]+$/u, 'Label names cannot contain spaces, @ or #'),
  color: hexColor,
  isFavorite: z.boolean(),
};
export const labelInputSchema = z.object({
  name: labelFields.name,
  color: labelFields.color.default('#64748b'),
  isFavorite: labelFields.isFavorite.default(false),
});
export type LabelInput = z.input<typeof labelInputSchema>;
export const labelPatchSchema = z.object(labelFields).partial();

/** Palette offered for projects and labels; restrained, accessible on light and dark. */
export const PALETTE: { name: string; value: string }[] = [
  { name: 'Slate', value: '#64748b' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Sky', value: '#0284c7' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Violet', value: '#7c3aed' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Brown', value: '#92400e' },
];

/** "taskId cannot be finished before dependsOnId". */
export interface DependencyEdge {
  taskId: string;
  dependsOnId: string;
}
