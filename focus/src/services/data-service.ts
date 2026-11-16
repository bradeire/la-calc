import type { SqlJsStatic } from 'sql.js';
import { z } from 'zod';
import type { Repositories } from '@/data';
import { SqlJsDriver } from '@/data/db/sqljs-driver';
import { currentSchemaVersion, integrityCheck, LATEST_SCHEMA_VERSION } from '@/data/migrations';
import { newId, nowIso } from '@/data/repositories/base';
import { loadSampleData } from '@/data/seed';
import type { FileStore } from '@/platform/types';
import { ValidationError } from './events';
import type { LabelService } from './label-service';
import type { ProjectService } from './project-service';
import type { TaskService } from './task-service';

/** Tables included in JSON backups, in foreign-key-safe insert order. */
export const BACKUP_TABLES = [
  'settings', 'projects', 'sections', 'labels', 'tasks', 'recurrence_rules', 'task_labels', 'reminders',
  'attachments', 'comments', 'activity_log', 'task_dependencies', 'time_entries', 'project_templates',
  'saved_filters', 'automations', 'automation_runs', 'calendar_connections', 'integrations', 'backup_history', 'change_log',
] as const;

const backupSchema = z.object({
  format: z.literal('focus-backup'),
  formatVersion: z.literal(1),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  attachments: z.record(z.string(), z.object({ type: z.string(), base64: z.string() })).optional(),
});
export type FocusBackup = z.infer<typeof backupSchema>;

export interface ImportSummary {
  tasks: number;
  projects: number;
  labels: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class DataService {
  constructor(
    private r: Repositories,
    private svc: { tasks: TaskService; projects: ProjectService; labels: LabelService },
    private files: FileStore,
    private sql: SqlJsStatic,
  ) {}

  hasSampleData(): boolean {
    return !!this.r.db.get(
      'SELECT 1 FROM tasks WHERE is_sample = 1 UNION SELECT 1 FROM projects WHERE is_sample = 1 UNION SELECT 1 FROM labels WHERE is_sample = 1 LIMIT 1',
    );
  }

  loadSampleData(now = new Date()): void {
    if (this.hasSampleData()) throw new ValidationError('Demonstration data is already loaded');
    this.r.db.transaction(() => loadSampleData(this.svc, now));
  }

  /**
   * Remove demonstration data. Tasks the user created inside sample projects
   * are moved to the Inbox first, never deleted (no silent data loss).
   */
  removeSampleData(): { rescued: number } {
    return this.r.db.transaction(() => {
      const rescued = this.r.db.all<{ id: string }>(
        `SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE p.is_sample = 1 AND t.is_sample = 0 AND t.parent_id IS NULL`,
      );
      for (const { id } of rescued) this.r.tasks.update(id, { projectId: null, sectionId: null });
      // Subtasks the user added under sample tasks are promoted rather than lost.
      for (const { id } of this.r.db.all<{ id: string }>(
        'SELECT t.id FROM tasks t JOIN tasks p ON p.id = t.parent_id WHERE p.is_sample = 1 AND t.is_sample = 0',
      )) {
        this.r.tasks.update(id, { parentId: null, projectId: null, sectionId: null });
      }
      this.r.db.run('UPDATE tasks SET project_id = NULL, section_id = NULL WHERE is_sample = 0 AND project_id IN (SELECT id FROM projects WHERE is_sample = 1)');
      this.r.db.run('DELETE FROM tasks WHERE is_sample = 1');
      this.r.db.run('UPDATE projects SET parent_id = NULL WHERE is_sample = 0 AND parent_id IN (SELECT id FROM projects WHERE is_sample = 1)');
      this.r.db.run('DELETE FROM projects WHERE is_sample = 1');
      this.r.db.run('DELETE FROM labels WHERE is_sample = 1');
      return { rescued: rescued.length };
    });
  }

  // --- Backup ----------------------------------------------------------------

  /** Full JSON backup including attachment bytes. */
  async exportJson(opts: { includeAttachments?: boolean } = {}): Promise<FocusBackup> {
    const tables: FocusBackup['tables'] = {};
    for (const t of BACKUP_TABLES) {
      tables[t] = this.r.db.all(`SELECT * FROM ${t}`).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? { $bytes: toBase64(v.buffer as ArrayBuffer) } : v;
        return out;
      });
    }
    const backup: FocusBackup = {
      format: 'focus-backup',
      formatVersion: 1,
      schemaVersion: currentSchemaVersion(this.r.db),
      exportedAt: nowIso(),
      tables,
    };
    if (opts.includeAttachments !== false) {
      backup.attachments = {};
      for (const key of this.r.attachments.allStorageKeys()) {
        const blob = await this.files.get(key);
        if (blob) backup.attachments[key] = { type: blob.type, base64: toBase64(await blob.arrayBuffer()) };
      }
    }
    return backup;
  }

  /** Validate a JSON backup without changing anything. */
  inspectJson(text: string): { backup: FocusBackup; summary: ImportSummary } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ValidationError('This file is not valid JSON');
    }
    const parsed = backupSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('This is not a Focus backup file');
    const b = parsed.data;
    if (b.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new ValidationError('This backup was made by a newer version of Focus. Update Focus before restoring it.');
    }
    return {
      backup: b,
      summary: {
        tasks: b.tables.tasks?.length ?? 0,
        projects: b.tables.projects?.length ?? 0,
        labels: b.tables.labels?.length ?? 0,
      },
    };
  }

  /**
   * Replace all data with the backup's contents, in one transaction. The caller
   * must have obtained explicit confirmation and saved a pre-import snapshot.
   */
  async restoreJson(backup: FocusBackup): Promise<ImportSummary> {
    if (backup.attachments) {
      for (const [key, a] of Object.entries(backup.attachments)) {
        if (!/^att_[0-9a-f-]{36}$/.test(key)) throw new ValidationError('Backup contains an invalid attachment key');
        await this.files.put(key, new Blob([fromBase64(a.base64) as BlobPart], { type: a.type }));
      }
    }
    this.r.db.transaction(() => {
      for (const t of [...BACKUP_TABLES].reverse()) this.r.db.run(`DELETE FROM ${t}`);
      for (const t of BACKUP_TABLES) {
        const rows = backup.tables[t] ?? [];
        if (!rows.length) continue;
        const allowed = new Set(this.r.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name));
        for (const row of rows) {
          const cols = Object.keys(row).filter((c) => allowed.has(c));
          if (!cols.length) continue;
          const values = cols.map((c) => {
            const v = row[c];
            if (v && typeof v === 'object' && '$bytes' in v) return fromBase64(String((v as { $bytes: string }).$bytes));
            if (v === null || typeof v === 'string' || typeof v === 'number') return v;
            if (typeof v === 'boolean') return v ? 1 : 0;
            throw new ValidationError(`Unexpected value in ${t}.${c}`);
          });
          this.r.db.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
        }
      }
      const check = integrityCheck(this.r.db);
      if (!check.ok) throw new ValidationError(`The backup failed verification: ${check.messages.join('; ')}`);
    });
    return { tasks: backup.tables.tasks?.length ?? 0, projects: backup.tables.projects?.length ?? 0, labels: backup.tables.labels?.length ?? 0 };
  }

  /** Raw SQLite image of the database, plus checksum, for a byte-exact backup. */
  async exportSqlite(): Promise<{ bytes: Uint8Array; sha256: string }> {
    const bytes = this.r.db.export();
    const sha256 = await sha256Hex(bytes);
    this.recordBackup('sqlite', bytes.length, sha256);
    return { bytes, sha256 };
  }

  /** Open a .sqlite file in isolation and verify it is a usable Focus database. */
  verifySqlite(bytes: Uint8Array): ImportSummary & { schemaVersion: number } {
    let probe: SqlJsDriver | null = null;
    try {
      probe = new SqlJsDriver(this.sql, bytes);
      const check = integrityCheck(probe);
      if (!check.ok) throw new ValidationError(`The database failed its integrity check: ${check.messages.join('; ')}`);
      const v = currentSchemaVersion(probe);
      if (v === 0) throw new ValidationError('This is not a Focus database');
      if (v > LATEST_SCHEMA_VERSION) throw new ValidationError('This database is from a newer version of Focus');
      const count = (t: string) => Number(probe!.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`)?.n ?? 0);
      return { schemaVersion: v, tasks: count('tasks'), projects: count('projects'), labels: count('labels') };
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError('This file is not a readable SQLite database');
    } finally {
      probe?.close();
    }
  }

  recordBackup(kind: string, size: number, checksum: string | null, status = 'created') {
    this.r.db.run(
      'INSERT INTO backup_history (id, kind, created_at, size_bytes, checksum, status, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), kind, nowIso(), size, checksum, status, status === 'verified' ? nowIso() : null],
    );
  }

  /** Round-trip check: a just-made JSON backup must parse and validate. */
  verifyJsonBackup(json: string): boolean {
    this.inspectJson(json);
    return true;
  }

  /** Empty Trash permanently. */
  async emptyTrash(): Promise<number> {
    const keys: string[] = [];
    const n = this.r.db.transaction(() => {
      for (const a of this.r.db.all<{ storage_key: string }>(
        `SELECT storage_key FROM attachments WHERE deleted_at IS NOT NULL
         OR task_id IN (SELECT id FROM tasks WHERE deleted_at IS NOT NULL)
         OR project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL)`,
      )) keys.push(a.storage_key);
      const count = Number(this.r.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NOT NULL')?.n ?? 0);
      this.r.db.run('DELETE FROM attachments WHERE deleted_at IS NOT NULL');
      this.r.db.run('DELETE FROM comments WHERE deleted_at IS NOT NULL');
      this.r.db.run('DELETE FROM tasks WHERE deleted_at IS NOT NULL');
      this.r.db.run('DELETE FROM sections WHERE deleted_at IS NOT NULL');
      this.r.db.run('DELETE FROM projects WHERE deleted_at IS NOT NULL');
      this.r.db.run('DELETE FROM labels WHERE deleted_at IS NOT NULL');
      return count;
    });
    for (const k of keys) await this.files.delete(k);
    return n;
  }
}
