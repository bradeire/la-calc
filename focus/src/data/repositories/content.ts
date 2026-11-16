import type { ActivityEntry, Attachment, Comment, Reminder, TimeEntry } from '@/core/domain/types';
import type { DatabaseDriver, Row } from '../db/driver';
import { newId, nowIso, num, numOrNull, str, strOrNull, track } from './base';

const mapComment = (r: Row): Comment => ({
  id: str(r.id),
  taskId: strOrNull(r.task_id),
  projectId: strOrNull(r.project_id),
  body: str(r.body),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  deletedAt: strOrNull(r.deleted_at),
});

const mapAttachment = (r: Row): Attachment => ({
  id: str(r.id),
  taskId: strOrNull(r.task_id),
  projectId: strOrNull(r.project_id),
  fileName: str(r.file_name),
  mimeType: str(r.mime_type),
  sizeBytes: num(r.size_bytes),
  storageKey: str(r.storage_key),
  createdAt: str(r.created_at),
  deletedAt: strOrNull(r.deleted_at),
});

const mapReminder = (r: Row): Reminder => ({
  id: str(r.id),
  taskId: str(r.task_id),
  kind: str(r.kind) as Reminder['kind'],
  remindAt: strOrNull(r.remind_at),
  offsetMinutes: numOrNull(r.offset_minutes),
  createdAt: str(r.created_at),
  deliveredAt: strOrNull(r.delivered_at),
  dismissedAt: strOrNull(r.dismissed_at),
  snoozedUntil: strOrNull(r.snoozed_until),
});

const mapActivity = (r: Row): ActivityEntry => ({
  id: str(r.id),
  entityType: str(r.entity_type) as ActivityEntry['entityType'],
  entityId: str(r.entity_id),
  action: str(r.action),
  payload: JSON.parse(str(r.payload_json) || '{}') as Record<string, unknown>,
  createdAt: str(r.created_at),
});

const mapTimeEntry = (r: Row): TimeEntry => ({
  id: str(r.id),
  taskId: str(r.task_id),
  startedAt: str(r.started_at),
  endedAt: strOrNull(r.ended_at),
  minutes: numOrNull(r.minutes),
  note: str(r.note),
  source: str(r.source) as TimeEntry['source'],
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  deletedAt: strOrNull(r.deleted_at),
});

export class CommentRepository {
  constructor(private db: DatabaseDriver) {}
  insert(c: { taskId?: string | null; projectId?: string | null; body: string; createdAt?: string }): string {
    const id = newId();
    const ts = c.createdAt ?? nowIso();
    this.db.run('INSERT INTO comments (id, task_id, project_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      c.taskId ?? null,
      c.projectId ?? null,
      c.body,
      ts,
      ts,
    ]);
    track(this.db, 'comments', id, 'insert');
    return id;
  }
  update(id: string, body: string) {
    this.db.run('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?', [body, nowIso(), id]);
    track(this.db, 'comments', id, 'update');
  }
  softDelete(id: string, at: string | null = nowIso()) {
    this.db.run('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, nowIso(), id]);
    track(this.db, 'comments', id, 'update');
  }
  listForTask(taskId: string): Comment[] {
    return this.db.all('SELECT * FROM comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at', [taskId]).map(mapComment);
  }
  listForProject(projectId: string): Comment[] {
    return this.db.all('SELECT * FROM comments WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at', [projectId]).map(mapComment);
  }
  countsForTasks(): Map<string, number> {
    const rows = this.db.all<{ task_id: string; n: number }>(
      'SELECT task_id, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL AND task_id IS NOT NULL GROUP BY task_id',
    );
    return new Map(rows.map((r) => [r.task_id, Number(r.n)]));
  }
}

export class AttachmentRepository {
  constructor(private db: DatabaseDriver) {}
  insert(a: Omit<Attachment, 'id' | 'createdAt' | 'deletedAt'>): string {
    const id = newId();
    this.db.run(
      'INSERT INTO attachments (id, task_id, project_id, file_name, mime_type, size_bytes, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, a.taskId, a.projectId, a.fileName, a.mimeType, a.sizeBytes, a.storageKey, nowIso()],
    );
    track(this.db, 'attachments', id, 'insert');
    return id;
  }
  get(id: string): Attachment | undefined {
    const r = this.db.get('SELECT * FROM attachments WHERE id = ?', [id]);
    return r ? mapAttachment(r) : undefined;
  }
  softDelete(id: string, at: string | null = nowIso()) {
    this.db.run('UPDATE attachments SET deleted_at = ? WHERE id = ?', [at, id]);
    track(this.db, 'attachments', id, 'update');
  }
  listForTask(taskId: string): Attachment[] {
    return this.db.all('SELECT * FROM attachments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at', [taskId]).map(mapAttachment);
  }
  listForProject(projectId: string): Attachment[] {
    return this.db.all('SELECT * FROM attachments WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at', [projectId]).map(mapAttachment);
  }
  allStorageKeys(): string[] {
    return this.db.all<{ k: string }>('SELECT storage_key AS k FROM attachments').map((r) => r.k);
  }
}

export class ReminderRepository {
  constructor(private db: DatabaseDriver) {}
  insert(r: { taskId: string; kind: Reminder['kind']; remindAt?: string | null; offsetMinutes?: number | null }): string {
    const id = newId();
    this.db.run('INSERT INTO reminders (id, task_id, kind, remind_at, offset_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      r.taskId,
      r.kind,
      r.remindAt ?? null,
      r.offsetMinutes ?? null,
      nowIso(),
    ]);
    track(this.db, 'reminders', id, 'insert');
    return id;
  }
  delete(id: string) {
    this.db.run('DELETE FROM reminders WHERE id = ?', [id]);
    track(this.db, 'reminders', id, 'delete');
  }
  listForTask(taskId: string): Reminder[] {
    return this.db.all('SELECT * FROM reminders WHERE task_id = ? ORDER BY created_at', [taskId]).map(mapReminder);
  }
  get(id: string): Reminder | undefined {
    const r = this.db.get('SELECT * FROM reminders WHERE id = ?', [id]);
    return r ? mapReminder(r) : undefined;
  }
  /** Reminders that could still fire: not dismissed, task open and not deleted, project not archived/deleted. */
  listActive(): Reminder[] {
    return this.db
      .all(
        `SELECT r.* FROM reminders r JOIN tasks t ON t.id = r.task_id
         WHERE r.dismissed_at IS NULL AND t.deleted_at IS NULL AND t.status IN ('inbox','active','in_progress','waiting')
         AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.archived_at IS NULL AND p.deleted_at IS NULL))`,
      )
      .map(mapReminder);
  }
  /** After a task's dates change, its relative reminders should fire again for the new time. */
  resetRelative(taskId: string) {
    this.db.run(
      "UPDATE reminders SET delivered_at = NULL, dismissed_at = NULL, snoozed_until = NULL WHERE task_id = ? AND kind = 'relative'",
      [taskId],
    );
  }
  setState(id: string, s: { deliveredAt?: string | null; dismissedAt?: string | null; snoozedUntil?: string | null }) {
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    if (s.deliveredAt !== undefined) (cols.push('delivered_at = ?'), vals.push(s.deliveredAt));
    if (s.dismissedAt !== undefined) (cols.push('dismissed_at = ?'), vals.push(s.dismissedAt));
    if (s.snoozedUntil !== undefined) (cols.push('snoozed_until = ?'), vals.push(s.snoozedUntil));
    if (!cols.length) return;
    this.db.run(`UPDATE reminders SET ${cols.join(', ')} WHERE id = ?`, [...vals, id]);
    track(this.db, 'reminders', id, 'update');
  }
}

export class ActivityRepository {
  constructor(private db: DatabaseDriver) {}
  log(entityType: ActivityEntry['entityType'], entityId: string, action: string, payload: Record<string, unknown> = {}) {
    this.db.run('INSERT INTO activity_log (id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      newId(),
      entityType,
      entityId,
      action,
      JSON.stringify(payload),
      nowIso(),
    ]);
  }
  listFor(entityId: string, limit = 100): ActivityEntry[] {
    return this.db
      .all('SELECT * FROM activity_log WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [entityId, limit])
      .map(mapActivity);
  }
  recent(limit = 100): ActivityEntry[] {
    return this.db.all('SELECT * FROM activity_log ORDER BY created_at DESC, rowid DESC LIMIT ?', [limit]).map(mapActivity);
  }
}

export class TimeEntryRepository {
  constructor(private db: DatabaseDriver) {}
  start(taskId: string, at = nowIso()): string {
    const id = newId();
    this.db.run("INSERT INTO time_entries (id, task_id, started_at, source, created_at, updated_at) VALUES (?, ?, ?, 'timer', ?, ?)", [
      id,
      taskId,
      at,
      at,
      at,
    ]);
    track(this.db, 'time_entries', id, 'insert');
    return id;
  }
  stop(id: string, at = nowIso()): number {
    const e = this.get(id);
    if (!e) throw new Error('Time entry not found');
    const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(e.startedAt)) / 60000));
    this.db.run('UPDATE time_entries SET ended_at = ?, minutes = ?, updated_at = ? WHERE id = ?', [at, minutes, at, id]);
    track(this.db, 'time_entries', id, 'update');
    return minutes;
  }
  addManual(taskId: string, startedAt: string, minutes: number, note = ''): string {
    const id = newId();
    const ts = nowIso();
    const ended = new Date(Date.parse(startedAt) + minutes * 60000).toISOString();
    this.db.run(
      "INSERT INTO time_entries (id, task_id, started_at, ended_at, minutes, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
      [id, taskId, startedAt, ended, minutes, note, ts, ts],
    );
    track(this.db, 'time_entries', id, 'insert');
    return id;
  }
  softDelete(id: string) {
    this.db.run('UPDATE time_entries SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);
    track(this.db, 'time_entries', id, 'update');
  }
  get(id: string): TimeEntry | undefined {
    const r = this.db.get('SELECT * FROM time_entries WHERE id = ?', [id]);
    return r ? mapTimeEntry(r) : undefined;
  }
  running(): TimeEntry | undefined {
    const r = this.db.get('SELECT * FROM time_entries WHERE ended_at IS NULL AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1');
    return r ? mapTimeEntry(r) : undefined;
  }
  listForTask(taskId: string): TimeEntry[] {
    return this.db.all('SELECT * FROM time_entries WHERE task_id = ? AND deleted_at IS NULL ORDER BY started_at DESC', [taskId]).map(mapTimeEntry);
  }
  totalMinutes(taskId: string): number {
    return num(this.db.get<{ m: number }>('SELECT SUM(minutes) AS m FROM time_entries WHERE task_id = ? AND deleted_at IS NULL', [taskId])?.m);
  }
}
