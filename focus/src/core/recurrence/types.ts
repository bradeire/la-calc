import { z } from 'zod';
import { isoDate } from '../domain/types';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/**
 * Structured recurrence rule, version 1. Never stored as free text (ADR-005).
 *  - weekdays: 0 = Monday … 6 = Sunday
 *  - monthDays: 1…31, or -1 for the last day of the month
 *  - nthWeekday: { n: 1…5 or -1 (last), weekday }
 */
export const recurrenceRuleSchema = z.object({
  v: z.literal(1),
  freq: z.enum(FREQUENCIES),
  interval: z.number().int().min(1).max(1000),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  monthDays: z.array(z.number().int().min(-1).max(31).refine((n) => n !== 0)).min(1).optional(),
  nthWeekday: z
    .object({ n: z.number().int().min(-1).max(5).refine((n) => n !== 0), weekday: z.number().int().min(0).max(6) })
    .optional(),
  month: z.number().int().min(1).max(12).optional(),
  basis: z.enum(['scheduled', 'completion']),
  /** Series anchor: occurrences are aligned to this date for interval > 1. */
  anchor: isoDate.optional(),
  until: isoDate.nullable().optional(),
});

export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;
