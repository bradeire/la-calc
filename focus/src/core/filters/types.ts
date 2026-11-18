import { z } from 'zod';
import { TASK_STATUSES } from '../domain/types';

/**
 * Filter definition (stored as JSON in saved_filters.definition_json, versioned).
 * Both the visual builder and the query language produce/consume this tree.
 */
export const DATE_FIELDS = ['scheduled', 'deadline', 'start', 'due', 'completed', 'created'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

/** Single-date operators take one date expression; range operators take two; the rest take none. */
export const DATE_OPS = ['on', 'before', 'after', 'onOrBefore', 'onOrAfter', 'between', 'none', 'any', 'overdue'] as const;
export type DateOp = (typeof DATE_OPS)[number];
export const CMP_OPS = ['=', '!=', '<', '<=', '>', '>='] as const;
export type CmpOp = (typeof CMP_OPS)[number];

export type Rule =
  | { kind: 'rule'; field: 'priority'; op: CmpOp; value: number }
  | { kind: 'rule'; field: 'status'; op: 'is' | 'isNot'; value: string[] }
  /** Project ids; 'inbox' means no project. Sub-projects are included. */
  | { kind: 'rule'; field: 'project'; op: 'in' | 'notIn'; value: string[] }
  /** Label ids. hasNone with an empty list = has no labels at all. */
  | { kind: 'rule'; field: 'label'; op: 'hasAny' | 'hasAll' | 'hasNone'; value: string[] }
  /** Date expressions: today, tomorrow, yesterday, ±Nd/w/m, YYYY-MM-DD, or a range keyword for 'on'. */
  | { kind: 'rule'; field: DateField; op: DateOp; value?: string; value2?: string }
  | { kind: 'rule'; field: 'duration'; op: CmpOp | 'none' | 'any'; value?: number }
  | { kind: 'rule'; field: 'text'; op: 'contains'; value: string }
  | { kind: 'rule'; field: 'dependency'; op: 'blocked' | 'blocking' | 'free' }
  | { kind: 'rule'; field: 'recurring' | 'subtask'; op: 'yes' | 'no' };

export interface Group {
  kind: 'group';
  op: 'and' | 'or';
  not?: boolean;
  children: Condition[];
}

export type Condition = Group | Rule | { kind: 'not'; child: Condition };

export interface FilterDefinition {
  v: 1;
  root: Condition;
}

const condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('group'), op: z.enum(['and', 'or']), not: z.boolean().optional(), children: z.array(condition) }),
    z.object({ kind: z.literal('not'), child: condition }),
    z.object({ kind: z.literal('rule'), field: z.string(), op: z.string(), value: z.unknown().optional(), value2: z.unknown().optional() }).passthrough(),
  ]),
) as z.ZodType<Condition>;

export const filterDefinitionSchema = z.object({ v: z.literal(1), root: condition });

export const STATUS_VALUES: readonly string[] = TASK_STATUSES;
