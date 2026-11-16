import { z } from 'zod';
import { addDays, diffDays, type ISODate } from './dates';
import { priority } from './domain/types';
import { recurrenceRuleSchema } from './recurrence/types';

/**
 * Project template, version 1. Dates are stored as day offsets from the project
 * start date chosen when the template is used, so a template made in March
 * produces sensible dates in November.
 */
export const templateTaskSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().default(''),
  priority: priority.default(4),
  section: z.string().nullable().default(null),
  parentRef: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  startOffset: z.number().int().nullable().default(null),
  scheduledOffset: z.number().int().nullable().default(null),
  scheduledTime: z.string().nullable().default(null),
  deadlineOffset: z.number().int().nullable().default(null),
  durationMinutes: z.number().int().positive().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  recurrence: recurrenceRuleSchema.nullable().default(null),
  recurrenceText: z.string().nullable().default(null),
});

export const templateSchema = z.object({
  v: z.literal(1),
  project: z.object({
    color: z.string().default('#0d9488'),
    icon: z.string().default('folder'),
    layout: z.enum(['list', 'board', 'table', 'calendar']).default('list'),
    description: z.string().default(''),
    notes: z.string().default(''),
  }),
  sections: z.array(z.string()).default([]),
  tasks: z.array(templateTaskSchema),
});

export type TemplateTask = z.infer<typeof templateTaskSchema>;
export type TemplateBody = z.infer<typeof templateSchema>;

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  taskCount: number;
}

export const offset = (date: ISODate | null, base: ISODate): number | null => (date ? diffDays(date, base) : null);
export const fromOffset = (n: number | null, base: ISODate): ISODate | null => (n === null ? null : addDays(base, n));

/** Built-in templates shipped with the app (spec 4.7 example). */
export const BUILT_IN_TEMPLATES: { id: string; name: string; description: string; body: TemplateBody }[] = [
  {
    id: 'builtin:holiday',
    name: 'Holiday planning',
    description: 'From choosing a destination to confirming arrangements. Dates count from the planning start date.',
    body: templateSchema.parse({
      v: 1,
      project: { color: '#0d9488', icon: 'plane', layout: 'list', description: 'Holiday plan' },
      sections: ['Plan', 'Book', 'Prepare'],
      tasks: [
        { ref: 'research', title: 'Research destination', section: 'Plan', priority: 2, scheduledOffset: 0, durationMinutes: 90 },
        { ref: 'budget', title: 'Agree a budget', section: 'Plan', scheduledOffset: 1, durationMinutes: 30 },
        { ref: 'stay', title: 'Book accommodation', section: 'Book', priority: 1, scheduledOffset: 3, deadlineOffset: 7, durationMinutes: 60, dependsOn: ['research', 'budget'] },
        { ref: 'transport', title: 'Arrange transport', section: 'Book', priority: 2, scheduledOffset: 4, deadlineOffset: 10, durationMinutes: 45, dependsOn: ['research'] },
        { ref: 'docs', title: 'Check travel documents', section: 'Prepare', priority: 2, scheduledOffset: 2, deadlineOffset: 14, durationMinutes: 20, description: 'Passports valid for 6+ months, visas, EHIC/GHIC, insurance.' },
        { ref: 'packing', title: 'Prepare packing list', section: 'Prepare', scheduledOffset: 18, durationMinutes: 30 },
        { ref: 'packing-meds', title: 'Medication and chargers', parentRef: 'packing' },
        { ref: 'packing-clothes', title: 'Clothes for the forecast', parentRef: 'packing' },
        { ref: 'confirm', title: 'Confirm arrangements', section: 'Prepare', priority: 1, scheduledOffset: 20, deadlineOffset: 21, durationMinutes: 30, dependsOn: ['stay', 'transport'] },
      ],
    }),
  },
];
