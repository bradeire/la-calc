import type { Priority, Task, TaskStatus } from '@/core/domain/types';
import { recurrenceRuleSchema, type RecurrenceRule } from '@/core/recurrence/types';
import type { DatabaseDriver, Row, SqlValue } from '../db/driver';
import { bool, newId, nowIso, num, numOrNull, placeholders, setClause, str, strOrNull, track } from './base';

const SELECT = `SELECT t.*, r.rule_json, r.source_text AS recurrence_text,
  (SELECT group_concat(label_id) FROM task_labels tl WHERE tl.task_id = t.id) AS label_ids
  FROM tasks t LEFT JOIN recurrence_rules r ON r.task_id = t.id`;

const OPEN = `t.status IN ('inbox','active','in_progress','waiting')`;
/** Excludes tasks whose project is archived or deleted. */
const VISIBLE_PROJECT = `(t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL AND p.deleted_at IS NULL))`;
const ORDER = 'ORDER BY t.sort_order, t.created_at';

function parseRule(json: SqlValue | undefined): RecurrenceRule | null {
  if (json == null) return null;
  const parsed = recurrenceRuleSchema.safeParse(JSON.parse(String(json)));
  if (!parsed.success) {
    console.error('Invalid stored recurrence rule ignored', parsed.error);
    return null;
  }
  return parsed.data;
}

export function mapTask(r: Row): Task {
  return {
    id: str(r.id),
    title: str(r.title),
    description: str(r.description),
    projectId: strOrNull(r.project_id),
    sectionId: strOrNull(r.section_id),
    parentId: strOrNull(r.parent_id),
    priority: num(r.priority) as Priority,
    status: str(r.status) as TaskStatus,
    startDate: strOrNull(r.start_date),
    scheduledDate: strOrNull(r.scheduled_date),
    scheduledTime: strOrNull(r.scheduled_time),
    deadline: strOrNull(r.deadline),
    durationMinutes: numOrNull(r.duration_minutes),
    actualMinutes: num(r.actual_minutes),
    completedAt: strOrNull(r.completed_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    deletedAt: strOrNull(r.deleted_at),
    sortOrder: num(r.sort_order),
    pinnedToday: bool(r.pinned_today),
    collapsed: bool(r.collapsed),
    seriesId: strOrNull(r.series_id),
    recurrence: parseRule(r.rule_json),
    recurrenceText: strOrNull(r.recurrence_text),
    labelIds: r.label_ids ? String(r.label_ids).split(',') : [],
    isSample: bool(r.is_sample),
  };
}

/** Column names for the writable task fields. */
const COLUMN: Partial<Record<keyof Task, string>> = {
  title: 'title',
  description: 'description',
  projectId: 'project_id',
  sectionId: 'section_id',
  parentId: 'parent_id',
  priority: 'priority',
  status: 'status',
  startDate: 'start_date',
  scheduledDate: 'scheduled_date',
  scheduledTime: 'scheduled_time',
  deadline: 'deadline',
  durationMinutes: 'duration_minutes',
  actualMinutes: 'actual_minutes',
  completedAt: 'completed_at',
  deletedAt: 'deleted_at',
  sortOrder: 'sort_order',
  pinnedToday: 'pinned_today',
  collapsed: 'collapsed',
  seriesId: 'series_id',
  isSample: 'is_sample',
};

function toSql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SqlValue;
}

export type NewTaskRow = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'labelIds' | 'recurrence' | 'recurrenceText'> & {
  id?: string;
  createdAt?: string;
};

export class TaskRepository {
  constructor(private db: DatabaseDriver) {}

  insert(row: NewTaskRow): string {
    const id = row.id ?? newId();
    const ts = nowIso();
    const cols: Record<string, SqlValue> = { id, created_at: row.createdAt ?? ts, updated_at: ts };
    for (const [k, col] of Object.entries(COLUMN)) cols[col] = toSql(row[k as keyof NewTaskRow]);
    const keys = Object.keys(cols);
    this.db.run(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${placeholders(keys.length)})`, keys.map((k) => cols[k]!));
    track(this.db, 'tasks', id, 'insert');
    return id;
  }

  update(id: string, patch: Partial<Task>): void {
    const cols: Record<string, SqlValue> = {};
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMN[k as keyof Task];
      if (col) cols[col] = toSql(v);
    }
    if (Object.keys(cols).length === 0) return;
    cols.updated_at = nowIso();
    const { sql, values } = setClause(cols);
    this.db.run(`UPDATE tasks SET ${sql} WHERE id = ?`, [...values, id]);
    track(this.db, 'tasks', id, 'update');
  }

  get(id: string): Task | undefined {
    const r = this.db.get(`${SELECT} WHERE t.id = ?`, [id]);
    return r ? mapTask(r) : undefined;
  }

  getMany(ids: readonly string[]): Task[] {
    if (ids.length === 0) return [];
    return this.db.all(`${SELECT} WHERE t.id IN (${placeholders(ids.length)}) ${ORDER}`, ids as string[]).map(mapTask);
  }

  setLabels(taskId: string, labelIds: readonly string[]): void {
    this.db.run('DELETE FROM task_labels WHERE task_id = ?', [taskId]);
    for (const l of new Set(labelIds)) this.db.run('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)', [taskId, l]);
  }

  setRecurrence(taskId: string, rule: RecurrenceRule | null, text: string | null): void {
    if (!rule) {
      this.db.run('DELETE FROM recurrence_rules WHERE task_id = ?', [taskId]);
      return;
    }
    const valid = recurrenceRuleSchema.parse(rule);
    const ts = nowIso();
    this.db.run(
      `INSERT INTO recurrence_rules (id, task_id, rule_version, rule_json, source_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET rule_version = excluded.rule_version, rule_json = excluded.rule_json,
         source_text = excluded.source_text, updated_at = excluded.updated_at`,
      [newId(), taskId, valid.v, JSON.stringify(valid), text, ts, ts],
    );
  }

  nextSortOrder(projectId: string | null, parentId: string | null): number {
    const r = this.db.get<{ m: number | null }>(
      'SELECT MAX(sort_order) AS m FROM tasks WHERE project_id IS ? AND parent_id IS ?',
      [projectId, parentId],
    );
    return (r?.m ?? 0) + 1;
  }

  /** Every non-deleted task in a project (all depths), open first. */
  listByProject(projectId: string, opts: { includeClosed?: boolean } = {}): Task[] {
    const status = opts.includeClosed ? '' : `AND ${OPEN}`;
    return this.db.all(`${SELECT} WHERE t.project_id = ? AND t.deleted_at IS NULL ${status} ${ORDER}`, [projectId]).map(mapTask);
  }

  listInbox(): Task[] {
    return this.db.all(`${SELECT} WHERE t.project_id IS NULL AND t.deleted_at IS NULL AND ${OPEN} ${ORDER}`).map(mapTask);
  }

  /** Overdue, scheduled today, deadline today or earlier, or pinned to Today. */
  listToday(today: string): Task[] {
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NULL AND ${OPEN} AND ${VISIBLE_PROJECT}
         AND (t.scheduled_date <= ? OR t.deadline <= ? OR t.pinned_today = 1)
         ORDER BY COALESCE(t.scheduled_date, t.deadline, '0000'), t.scheduled_time IS NULL, t.scheduled_time, t.priority, t.sort_order`,
        [today, today],
      )
      .map(mapTask);
  }

  /** Open tasks scheduled, or with a deadline, in [from, to]. */
  listBetween(from: string, to: string): Task[] {
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NULL AND ${OPEN} AND ${VISIBLE_PROJECT}
         AND ((t.scheduled_date BETWEEN ? AND ?) OR (t.deadline BETWEEN ? AND ?))
         ORDER BY COALESCE(t.scheduled_date, t.deadline), t.scheduled_time IS NULL, t.scheduled_time, t.priority, t.sort_order`,
        [from, to, from, to],
      )
      .map(mapTask);
  }

  listByLabel(labelId: string): Task[] {
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NULL AND ${OPEN}
         AND EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?) ${ORDER}`,
        [labelId],
      )
      .map(mapTask);
  }

  listCompleted(fromIso: string, toIso: string, limit = 500): Task[] {
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NULL AND t.status = 'completed' AND t.completed_at BETWEEN ? AND ?
         ORDER BY t.completed_at DESC LIMIT ?`,
        [fromIso, toIso, limit],
      )
      .map(mapTask);
  }

  /** Top-most deleted tasks (children deleted along with a parent are restored with it). */
  listTrash(): Task[] {
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NOT NULL
         AND (t.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.deleted_at = t.deleted_at))
         AND (t.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.deleted_at = t.deleted_at))
         ORDER BY t.deleted_at DESC`,
      )
      .map(mapTask);
  }

  /** All descendants of the given task (any depth). */
  descendantIds(id: string, opts: { includeDeleted?: boolean } = {}): string[] {
    const del = opts.includeDeleted ? '' : 'AND t.deleted_at IS NULL';
    return this.db
      .all<{ id: string }>(
        `WITH RECURSIVE d(id) AS (
           SELECT id FROM tasks WHERE parent_id = ?
           UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id WHERE 1=1 ${del}
         ) SELECT id FROM d`,
        [id],
      )
      .map((r) => r.id);
  }

  /** Ancestor chain, nearest first. */
  ancestors(id: string): Task[] {
    const out: Task[] = [];
    let cur = this.get(id);
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      cur = this.get(cur.parentId);
      if (cur) out.push(cur);
    }
    return out;
  }

  children(parentId: string): Task[] {
    return this.db.all(`${SELECT} WHERE t.parent_id = ? AND t.deleted_at IS NULL ${ORDER}`, [parentId]).map(mapTask);
  }

  /** Subtask progress (direct + nested) for many parents at once. */
  progressFor(parentIds: readonly string[]): Map<string, { done: number; total: number }> {
    const out = new Map<string, { done: number; total: number }>();
    if (parentIds.length === 0) return out;
    const rows = this.db.all<{ root: string; done: number; total: number }>(
      `WITH RECURSIVE d(root, id, status) AS (
         SELECT parent_id, id, status FROM tasks WHERE parent_id IN (${placeholders(parentIds.length)}) AND deleted_at IS NULL
         UNION ALL SELECT d.root, t.id, t.status FROM tasks t JOIN d ON t.parent_id = d.id WHERE t.deleted_at IS NULL
       )
       SELECT root, SUM(status = 'completed') AS done, SUM(status NOT IN ('cancelled','archived')) AS total FROM d GROUP BY root`,
      parentIds as string[],
    );
    for (const r of rows) out.set(r.root, { done: Number(r.done), total: Number(r.total) });
    return out;
  }

  openTaskInSeries(seriesId: string, excludeId?: string): Task | undefined {
    const r = this.db.get(
      `${SELECT} WHERE t.series_id = ? AND t.deleted_at IS NULL AND ${OPEN} AND t.id IS NOT ? LIMIT 1`,
      [seriesId, excludeId ?? null],
    );
    return r ? mapTask(r) : undefined;
  }

  /**
   * Full-text search across task titles, descriptions and comments, plus
   * project and label names. Prefix matching on every word.
   */
  search(query: string, limit = 200): Task[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/["*()^:{}-]/g, ''))
      .filter(Boolean);
    if (words.length === 0) return [];
    const match = words.map((w) => `"${w}*"`).join(' ');
    const like = `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return this.db
      .all(
        `${SELECT} WHERE t.deleted_at IS NULL AND (
           t.rowid IN (SELECT docid FROM tasks_fts WHERE tasks_fts MATCH ?)
           OR t.id IN (SELECT c.task_id FROM comments c WHERE c.deleted_at IS NULL AND c.rowid IN (SELECT docid FROM comments_fts WHERE comments_fts MATCH ?))
           OR t.project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\')
           OR EXISTS (SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id AND l.name LIKE ? ESCAPE '\\')
         )
         ORDER BY t.status IN ('completed','cancelled','archived'), t.updated_at DESC LIMIT ?`,
        [match, match, like, like, limit],
      )
      .map(mapTask);
  }

  countOpen(where: 'inbox' | { today: string }): number {
    if (where === 'inbox') {
      return num(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id IS NULL AND t.parent_id IS NULL AND t.deleted_at IS NULL AND ${OPEN}`)?.n);
    }
    return num(
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks t WHERE t.deleted_at IS NULL AND ${OPEN} AND ${VISIBLE_PROJECT}
         AND (t.scheduled_date <= ? OR t.deadline <= ? OR t.pinned_today = 1)`,
        [where.today, where.today],
      )?.n,
    );
  }

  hardDelete(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db.run(`DELETE FROM tasks WHERE id IN (${placeholders(ids.length)})`, ids as string[]);
    for (const id of ids) track(this.db, 'tasks', id, 'delete');
  }
}
