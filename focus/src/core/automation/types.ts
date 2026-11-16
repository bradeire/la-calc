import { z } from 'zod';
import { filterDefinitionSchema } from '../filters/types';
import { TASK_STATUSES } from '../domain/types';

/** Trigger → conditions → actions (spec 5.4). Stored as JSON in the automations table. */
export const TRIGGER_TYPES = [
  'task.created', 'task.completed', 'subtask.completed', 'task.overdue', 'deadline.approaching', 'scheduled.reached',
  'task.priorityChanged', 'task.labelAdded', 'task.moved', 'task.waitingTooLong', 'project.created', 'project.completed',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Triggers found by the periodic sweep rather than by an event. */
export const TIME_TRIGGERS: readonly TriggerType[] = ['task.overdue', 'deadline.approaching', 'scheduled.reached', 'task.waitingTooLong'];
export const PROJECT_TRIGGERS: readonly TriggerType[] = ['project.created', 'project.completed'];

export const triggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  /** deadline.approaching: days ahead; task.waitingTooLong: days waiting. */
  days: z.number().int().min(0).max(365).optional(),
  /** task.labelAdded: only this label. */
  labelId: z.string().optional(),
  /** project triggers: only projects whose name contains this text. */
  nameContains: z.string().max(100).optional(),
});

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('createTask'),
    title: z.string().min(1).max(500),
    projectId: z.string().nullable().default(null),
    sameProject: z.boolean().default(false),
    scheduleInDays: z.number().int().min(0).max(365).nullable().default(null),
    priority: z.number().int().min(1).max(4).default(4),
  }),
  z.object({ type: z.literal('createSubtask'), title: z.string().min(1).max(500) }),
  z.object({ type: z.literal('setPriority'), priority: z.number().int().min(1).max(4) }),
  z.object({ type: z.literal('addLabel'), labelId: z.string().min(1) }),
  z.object({ type: z.literal('removeLabel'), labelId: z.string().min(1) }),
  z.object({ type: z.literal('moveToProject'), projectId: z.string().nullable() }),
  z.object({ type: z.literal('setStatus'), status: z.enum(TASK_STATUSES) }),
  z.object({ type: z.literal('scheduleInDays'), days: z.number().int().min(0).max(365) }),
  z.object({ type: z.literal('createReminder'), minutesBefore: z.number().int().min(0).max(60 * 24 * 30) }),
  z.object({ type: z.literal('notify'), message: z.string().min(1).max(500) }),
  z.object({ type: z.literal('webhook'), webhookId: z.string().min(1) }),
  z.object({ type: z.literal('archiveTask') }),
  z.object({ type: z.literal('archiveProject') }),
  z.object({ type: z.literal('applyTemplate'), templateId: z.string().min(1) }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const automationInputSchema = z.object({
  name: z.string().trim().min(1, 'An automation needs a name').max(120),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  /** Optional task conditions, using the filter tree (ignored for project triggers). */
  conditions: filterDefinitionSchema.nullable().default(null),
  actions: z.array(actionSchema).min(1, 'Add at least one action').max(10),
  maxRunsPerHour: z.number().int().min(1).max(1000).default(60),
});
export type AutomationInput = z.input<typeof automationInputSchema>;
export type AutomationDef = z.output<typeof automationInputSchema>;

export interface Automation extends AutomationDef {
  id: string;
  lastRunAt: string | null;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  eventKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  details: Record<string, unknown>;
}

/** Fill {{task.title}}, {{project.name}} and {{date}} placeholders. */
export function renderTemplate(text: string, vars: { taskTitle?: string; projectName?: string; date: string }): string {
  return text
    .replace(/\{\{\s*task\.title\s*\}\}/g, vars.taskTitle ?? '')
    .replace(/\{\{\s*project\.name\s*\}\}/g, vars.projectName ?? '')
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .trim();
}
