import { z } from 'zod';
import { csvRecords, toCsv } from '@/core/csv';
import { todayISO, type ISODate } from '@/core/dates';
import { TASK_STATUSES, type Priority, type Task, type TaskStatus } from '@/core/domain/types';
import { parseQuickAdd } from '@/core/nlp/parser';
import { recurrenceRuleSchema, type RecurrenceRule } from '@/core/recurrence/types';
import type { Repositories } from '@/data';
import type { ContentService } from './content-service';
import { ValidationError, type EventBus } from './events';
import type { LabelService } from './label-service';
import type { ProjectService } from './project-service';
import type { TaskService } from './task-service';

/** Columns of Focus's own CSV (spec 6.6). Import also accepts any subset with a Title column. */
export const CSV_COLUMNS = [
  'ID', 'Parent ID', 'Title', 'Description', 'Project', 'Section', 'Priority', 'Status', 'Labels', 'Start date', 'Scheduled date',
  'Scheduled time', 'Deadline', 'Duration (minutes)', 'Repeat', 'Repeat rule', 'Completed at', 'Created at',
] as const;

export interface ImportRow {
  line: number;
  title: string;
  /** Problems that stop the row importing. */
  error?: string;
  /** Things that were kept but not understood (e.g. a date), so the user can check. */
  warning?: string;
  duplicate?: boolean;
}
export interface ImportPreview {
  format: 'focus' | 'todoist' | 'generic';
  rows: ImportRow[];
  tasks: number;
  newProjects: string[];
  newLabels: string[];
  skipped: number;
}
export interface ImportResult {
  created: number;
  taskIds: string[];
  projectIds: string[];
}

/** One project (or one task with its subtasks) with absolute dates, for moving between devices. */
const taskItemSchema = z.object({
  key: z.string(),
  parentKey: z.string().nullable(),
  sectionKey: z.string().nullable(),
  title: z.string().min(1).max(500),
  description: z.string().max(20000).default(''),
  priority: z.number().int().min(1).max(4),
  status: z.enum(TASK_STATUSES),
  startDate: z.string().nullable(),
  scheduledDate: z.string().nullable(),
  scheduledTime: z.string().nullable(),
  deadline: z.string().nullable(),
  durationMinutes: z.number().int().positive().nullable(),
  labels: z.array(z.string()),
  recurrence: recurrenceRuleSchema.nullable(),
  recurrenceText: z.string().nullable(),
  completedAt: z.string().nullable(),
  comments: z.array(z.string()).default([]),
});
export const projectFileSchema = z.object({
  format: z.literal('focus-project'),
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  project: z
    .object({ name: z.string().min(1).max(120), description: z.string().default(''), notes: z.string().default(''), color: z.string(), icon: z.string(), layout: z.enum(['list', 'board', 'table', 'calendar']) })
    .nullable(),
  sections: z.array(z.object({ key: z.string(), name: z.string().min(1) })),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  tasks: z.array(taskItemSchema).min(1).max(20000),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const FORMULA_ESCAPE = /^'[=+\-@]/;
const unescapeCell = (s: string) => (FORMULA_ESCAPE.test(s) ? s.slice(1) : s);

interface Draft {
  line: number;
  key: string;
  parentKey: string | null;
  title: string;
  description: string;
  projectPath: string | null;
  section: string | null;
  priority: Priority;
  status: TaskStatus | null;
  labels: string[];
  startDate: ISODate | null;
  scheduledDate: ISODate | null;
  scheduledTime: string | null;
  deadline: ISODate | null;
  durationMinutes: number | null;
  recurrence: RecurrenceRule | null;
  recurrenceText: string | null;
  completedAt: string | null;
  comments: string[];
  existingId: string | null;
  error?: string;
  warning?: string;
}

/**
 * Import and export beyond full backups (spec 6.6): CSV for spreadsheets and other apps,
 * Todoist project CSVs, and single-project / single-task files. Imports only ever add data,
 * never change or delete existing tasks, run in one transaction, skip tasks that already
 * exist (same ID), and do not trigger automations.
 */
export class TransferService {
  constructor(
    private r: Repositories,
    private events: EventBus,
    private svc: { tasks: TaskService; projects: ProjectService; labels: LabelService; content: ContentService },
    private now: () => Date = () => new Date(),
  ) {}

  // ---------- CSV export ----------

  private projectPath(id: string | null, cache = new Map<string, string>()): string {
    if (!id) return '';
    if (cache.has(id)) return cache.get(id)!;
    const p = this.r.projects.get(id);
    const path = p ? (p.parentId ? `${this.projectPath(p.parentId, cache)} / ${p.name}` : p.name) : '';
    cache.set(id, path);
    return path;
  }

  /** Tasks as CSV: all tasks, or one project (with sub-projects' tasks excluded). */
  exportCsv(opts: { projectId?: string | null; includeCompleted?: boolean } = {}): { filename: string; text: string; count: number } {
    const labels = new Map(this.r.labels.list().map((l) => [l.id, l.name]));
    const cache = new Map<string, string>();
    let tasks = this.r.tasks.listForReports();
    if (opts.projectId) tasks = tasks.filter((t) => t.projectId === opts.projectId);
    if (!opts.includeCompleted) tasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
    // Parents before children so a re-import can link them.
    const depth = (t: Task): number => (t.parentId ? 1 + depth(this.r.tasks.get(t.parentId) ?? { ...t, parentId: null }) : 0);
    tasks.sort((a, b) => depth(a) - depth(b) || a.sortOrder - b.sortOrder);
    const rows = tasks.map((t) => [
      t.id,
      t.parentId ?? '',
      t.title,
      t.description,
      this.projectPath(t.projectId, cache),
      t.sectionId ? (this.r.projects.getSection(t.sectionId)?.name ?? '') : '',
      t.priority,
      t.status,
      t.labelIds.map((id) => labels.get(id)).filter(Boolean).join(', '),
      t.startDate ?? '',
      t.scheduledDate ?? '',
      t.scheduledTime ?? '',
      t.deadline ?? '',
      t.durationMinutes ?? '',
      t.recurrenceText ?? '',
      t.recurrence ? JSON.stringify(t.recurrence) : '',
      t.completedAt ?? '',
      t.createdAt,
    ]);
    const name = opts.projectId ? (this.r.projects.get(opts.projectId)?.name ?? 'project') : 'tasks';
    const slug = name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'tasks';
    return { filename: `focus-${slug}-${todayISO(this.now())}.csv`, text: toCsv(CSV_COLUMNS, rows), count: rows.length };
  }

  // ---------- CSV import ----------

  private parseDate(raw: string, label: string, d: Draft): ISODate | null {
    const s = raw.trim();
    if (!s) return null;
    if (ISO.test(s)) return s;
    const order = this.r.settings.getAll().dateOrder;
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) {
      const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
      const [day, month] = order === 'mdy' ? [b, a] : [a, b];
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const p = parseQuickAdd(`x ${s}`, { now: this.now() });
    if (p.title === 'x' && p.scheduledDate) return p.scheduledDate;
    d.warning = `${label} “${s}” wasn’t understood and was left out`;
    return null;
  }

  private draftsFromFocus(records: Record<string, string>[]): Draft[] {
    const col = (r: Record<string, string>, ...names: string[]) => {
      for (const n of names) if (r[n] !== undefined) return unescapeCell(r[n]!);
      return '';
    };
    return records.map((r, i) => {
      const d: Draft = {
        line: i + 2,
        key: col(r, 'id') || `row${i}`,
        parentKey: col(r, 'parent id') || null,
        title: col(r, 'title', 'task', 'name', 'content'),
        description: col(r, 'description', 'notes'),
        projectPath: col(r, 'project') || null,
        section: col(r, 'section') || null,
        priority: 4,
        status: null,
        labels: col(r, 'labels', 'tags').split(/[,;]/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean),
        startDate: null,
        scheduledDate: null,
        scheduledTime: null,
        deadline: null,
        durationMinutes: null,
        recurrence: null,
        recurrenceText: null,
        completedAt: col(r, 'completed at') || null,
        comments: [],
        existingId: null,
      };
      const pr = col(r, 'priority').replace(/^p/i, '');
      if (pr) {
        const n = Number(pr);
        if ([1, 2, 3, 4].includes(n)) d.priority = n as Priority;
        else d.warning = `Priority “${pr}” wasn’t understood`;
      }
      const st = col(r, 'status').toLowerCase().replace(/\s+/g, '_');
      if (st) {
        if ((TASK_STATUSES as readonly string[]).includes(st)) d.status = st as TaskStatus;
        else if (['done', 'complete', 'yes', 'true', 'x'].includes(st)) d.status = 'completed';
      }
      d.startDate = this.parseDate(col(r, 'start date', 'start'), 'Start date', d);
      d.scheduledDate = this.parseDate(col(r, 'scheduled date', 'date', 'due date', 'due'), 'Date', d);
      const time = col(r, 'scheduled time', 'time');
      if (time) {
        if (TIME.test(time)) d.scheduledTime = time.padStart(5, '0');
        else d.warning = `Time “${time}” wasn’t understood`;
      }
      d.deadline = this.parseDate(col(r, 'deadline'), 'Deadline', d);
      const dur = col(r, 'duration (minutes)', 'duration', 'estimate');
      if (dur) {
        const n = Number(dur);
        if (Number.isInteger(n) && n > 0) d.durationMinutes = n;
        else d.warning = `Duration “${dur}” wasn’t understood`;
      }
      const ruleJson = col(r, 'repeat rule');
      const repeatText = col(r, 'repeat', 'recurrence');
      if (ruleJson) {
        try {
          d.recurrence = recurrenceRuleSchema.parse(JSON.parse(ruleJson));
          d.recurrenceText = repeatText || null;
        } catch {
          d.warning = 'The repeat rule wasn’t valid and was left out';
        }
      } else if (repeatText) {
        const p = parseQuickAdd(`x ${repeatText}`, { now: this.now() });
        if (p.recurrence) {
          d.recurrence = p.recurrence;
          d.recurrenceText = p.recurrenceText;
          if (!d.scheduledDate && p.scheduledDate) d.scheduledDate = p.scheduledDate;
        } else d.warning = `Repeat “${repeatText}” wasn’t understood and was left out`;
      }
      if (!d.title) d.error = 'No title';
      else if (d.title.length > 500) d.error = 'Title longer than 500 characters';
      return d;
    });
  }

  /** Todoist project CSV (TYPE, CONTENT, DESCRIPTION, PRIORITY, INDENT, DATE, DURATION, DURATION_UNIT, DEADLINE). */
  private draftsFromTodoist(records: Record<string, string>[], projectName: string): Draft[] {
    const out: Draft[] = [];
    const parents: string[] = [];
    let section: string | null = null;
    records.forEach((r, i) => {
      const type = (r.type ?? '').toLowerCase();
      const content = r.content ?? '';
      if (type === 'section') {
        section = content.trim() || null;
        parents.length = 0;
        return;
      }
      if (type === 'note') {
        const last = out[out.length - 1];
        if (last && content.trim()) last.comments.push(content.trim());
        return;
      }
      if (type !== 'task') return;
      const labels: string[] = [];
      const title = content
        .replace(/(^|\s)@([^\s@#]+)/g, (_m, sp: string, name: string) => {
          labels.push(name);
          return sp;
        })
        .replace(/\s+/g, ' ')
        .trim();
      const indent = Math.max(1, Number(r.indent) || 1);
      const key = `todoist${i}`;
      parents.length = indent - 1;
      const d: Draft = {
        line: i + 2,
        key,
        parentKey: indent > 1 ? (parents[indent - 2] ?? null) : null,
        title,
        description: r.description ?? '',
        projectPath: projectName,
        section,
        // Todoist CSV: 1 = p1 (highest) … 4 = p4, the same as Focus. Empty means no priority here.
        priority: ([1, 2, 3, 4].includes(Number(r.priority)) ? Number(r.priority) : 4) as Priority,
        status: null,
        labels,
        startDate: null,
        scheduledDate: null,
        scheduledTime: null,
        deadline: null,
        durationMinutes: null,
        recurrence: null,
        recurrenceText: null,
        completedAt: null,
        comments: [],
        existingId: null,
      };
      parents[indent - 1] = key;
      const date = (r.date ?? '').trim();
      if (date) {
        const p = parseQuickAdd(`x ${date}`, { now: this.now() });
        if (p.title === 'x' && (p.scheduledDate || p.recurrence)) {
          d.scheduledDate = p.scheduledDate;
          d.scheduledTime = p.scheduledTime;
          d.recurrence = p.recurrence;
          d.recurrenceText = p.recurrenceText;
        } else {
          d.warning = `Date “${date}” wasn’t understood; it was added to the description`;
          d.description = [d.description, `Todoist date: ${date}`].filter(Boolean).join('\n');
        }
      }
      d.deadline = this.parseDate(r.deadline ?? '', 'Deadline', d);
      const dur = Number(r.duration);
      if (Number.isInteger(dur) && dur > 0) d.durationMinutes = (r.duration_unit ?? '').toLowerCase().startsWith('day') ? Math.min(dur * 1440, 43200) : dur;
      if (!d.title) d.error = 'No title';
      out.push(d);
    });
    return out;
  }

  private drafts(text: string, fileName: string): { format: ImportPreview['format']; drafts: Draft[] } {
    const { headers, records } = csvRecords(text);
    if (!headers.length) throw new ValidationError('The file is empty');
    if (records.length > 20000) throw new ValidationError('Files are limited to 20,000 rows');
    if (headers.includes('type') && headers.includes('content')) {
      const name = fileName.replace(/\.csv$/i, '').trim() || 'Imported from Todoist';
      return { format: 'todoist', drafts: this.draftsFromTodoist(records, name) };
    }
    if (!['title', 'task', 'name', 'content'].some((h) => headers.includes(h))) {
      throw new ValidationError('No “Title” column found. The first row must name the columns, e.g. Title, Project, Scheduled date.');
    }
    return { format: headers.includes('repeat rule') ? 'focus' : 'generic', drafts: this.draftsFromFocus(records) };
  }

  private findProjectByPath(path: string): string | null {
    const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
    let parent: string | null = null;
    for (const name of parts) {
      const p = this.r.projects.list({ includeArchived: true }).find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase());
      if (!p) return null;
      parent = p.id;
    }
    return parent;
  }

  private markDuplicates(drafts: Draft[]) {
    for (const d of drafts) if (/^[0-9a-f-]{36}$/i.test(d.key) && this.r.tasks.get(d.key) && !this.r.tasks.get(d.key)!.deletedAt) d.existingId = d.key;
  }

  /** Read a CSV and report what would be imported, without changing anything. */
  previewCsv(text: string, fileName = 'import.csv'): ImportPreview {
    const { format, drafts } = this.drafts(text, fileName);
    this.markDuplicates(drafts);
    const ok = drafts.filter((d) => !d.error && !d.existingId);
    const newProjects = [...new Set(ok.map((d) => d.projectPath).filter((p): p is string => !!p && !this.findProjectByPath(p)))];
    const newLabels = [...new Set(ok.flatMap((d) => d.labels))].filter((n) => !this.r.labels.findByName(n));
    return {
      format,
      rows: drafts.map((d) => ({ line: d.line, title: d.title, error: d.error, warning: d.warning, duplicate: !!d.existingId })),
      tasks: ok.length,
      newProjects,
      newLabels,
      skipped: drafts.length - ok.length,
    };
  }

  importCsv(text: string, fileName = 'import.csv'): ImportResult {
    const { drafts } = this.drafts(text, fileName);
    this.markDuplicates(drafts);
    return this.commit(drafts.filter((d) => !d.error && !d.existingId));
  }

  private ensureProjectPath(path: string, created: string[]): string {
    const existing = this.findProjectByPath(path);
    if (existing) return existing;
    let parent: string | null = null;
    for (const name of path.split('/').map((p) => p.trim()).filter(Boolean)) {
      const found = this.r.projects.list({ includeArchived: true }).find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase());
      if (found) parent = found.id;
      else {
        parent = this.svc.projects.create({ name: name.slice(0, 120), parentId: parent }).id;
        created.push(parent);
      }
    }
    return parent!;
  }

  private ensureSection(projectId: string, name: string): string {
    const s = this.r.projects.listSections(projectId).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return s ? s.id : this.svc.projects.addSection(projectId, name);
  }

  /** Create drafts in order (parents first), quietly: imports don't trigger automations. */
  private commit(drafts: Draft[], target: { projectId?: string | null } = {}): ImportResult {
    const taskIds: string[] = [];
    const projectIds: string[] = [];
    this.events.quietly(() =>
      this.r.db.transaction(() => {
        const keyToId = new Map<string, string>();
        const pending = [...drafts];
        // Parents can appear after children in hand-made files: resolve in passes.
        for (let pass = 0; pending.length && pass < 50; pass++) {
          for (let i = 0; i < pending.length; ) {
            const d = pending[i]!;
            const parentInFile = d.parentKey && drafts.some((x) => x.key === d.parentKey);
            if (parentInFile && !keyToId.has(d.parentKey!)) {
              i++;
              continue;
            }
            const parentId = d.parentKey ? (keyToId.get(d.parentKey) ?? (this.r.tasks.get(d.parentKey) && !this.r.tasks.get(d.parentKey)!.deletedAt ? d.parentKey : null)) : null;
            let projectId: string | null = target.projectId ?? null;
            if (target.projectId === undefined && d.projectPath) projectId = this.ensureProjectPath(d.projectPath, projectIds);
            if (parentId) projectId = this.r.tasks.get(parentId)!.projectId;
            const sectionId = projectId && d.section && !parentId ? this.ensureSection(projectId, d.section) : null;
            const labelIds = d.labels.length ? this.svc.labels.ensure(d.labels) : [];
            const t = this.svc.tasks.create({
              title: d.title,
              description: d.description,
              projectId,
              sectionId,
              parentId,
              priority: d.priority,
              status: d.status === 'completed' ? 'completed' : (d.status ?? undefined),
              startDate: d.startDate,
              scheduledDate: d.scheduledDate,
              scheduledTime: d.scheduledDate ? d.scheduledTime : null,
              deadline: d.deadline,
              durationMinutes: d.durationMinutes,
              labelIds,
              recurrence: d.recurrence,
              recurrenceText: d.recurrenceText,
            });
            if (d.status === 'completed' && d.completedAt && Number.isFinite(Date.parse(d.completedAt))) {
              this.r.tasks.update(t.id, { completedAt: new Date(d.completedAt).toISOString() });
            }
            for (const c of d.comments) this.svc.content.addComment(t.id, c);
            keyToId.set(d.key, t.id);
            taskIds.push(t.id);
            pending.splice(i, 1);
          }
        }
        if (pending.length) throw new ValidationError('Some tasks refer to parents in a loop; nothing was imported');
      }),
    );
    return { created: taskIds.length, taskIds, projectIds };
  }

  /** Undo an import: move what it created to Trash. */
  undoImport(r: ImportResult) {
    this.svc.tasks.remove(r.taskIds.filter((id) => this.r.tasks.get(id) && !this.r.tasks.get(id)!.deletedAt));
    for (const id of r.projectIds) if (this.r.projects.get(id) && !this.r.projects.get(id)!.deletedAt) this.svc.projects.remove(id);
  }

  // ---------- Project and task files ----------

  private toItems(tasks: Task[], sectionKeys: Map<string, string>): ProjectFile['tasks'] {
    const labels = new Map(this.r.labels.list().map((l) => [l.id, l.name]));
    return tasks.map((t) => ({
      key: t.id,
      parentKey: t.parentId && tasks.some((x) => x.id === t.parentId) ? t.parentId : null,
      sectionKey: t.sectionId ? (sectionKeys.get(t.sectionId) ?? null) : null,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      startDate: t.startDate,
      scheduledDate: t.scheduledDate,
      scheduledTime: t.scheduledTime,
      deadline: t.deadline,
      durationMinutes: t.durationMinutes,
      labels: t.labelIds.map((id) => labels.get(id)).filter((x): x is string => !!x),
      recurrence: t.recurrence,
      recurrenceText: t.recurrenceText,
      completedAt: t.completedAt,
      comments: this.r.comments.listForTask(t.id).map((c) => c.body),
    }));
  }

  exportProject(projectId: string): { filename: string; text: string } {
    const p = this.r.projects.get(projectId);
    if (!p || p.deletedAt) throw new ValidationError('Project not found');
    const sections = this.r.projects.listSections(projectId);
    const sectionKeys = new Map(sections.map((s) => [s.id, s.id]));
    const tasks = this.r.tasks.listByProject(projectId, { includeClosed: true });
    if (!tasks.length) throw new ValidationError('This project has no tasks to export');
    const usedLabels = new Set(tasks.flatMap((t) => t.labelIds));
    const file: ProjectFile = {
      format: 'focus-project',
      formatVersion: 1,
      exportedAt: this.now().toISOString(),
      project: { name: p.name, description: p.description, notes: p.notes, color: p.color, icon: p.icon, layout: p.layout },
      sections: sections.map((s) => ({ key: s.id, name: s.name })),
      labels: this.r.labels.list().filter((l) => usedLabels.has(l.id)).map((l) => ({ name: l.name, color: l.color })),
      tasks: this.toItems(tasks, sectionKeys),
    };
    const slug = p.name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
    return { filename: `focus-project-${slug}.json`, text: JSON.stringify(file, null, 2) };
  }

  /** One task and its subtasks. */
  exportTask(taskId: string): { filename: string; text: string } {
    const root = this.r.tasks.get(taskId);
    if (!root || root.deletedAt) throw new ValidationError('Task not found');
    const ids = [taskId, ...this.r.tasks.descendantIds(taskId)];
    const tasks = this.r.tasks.getMany(ids).filter((t) => !t.deletedAt);
    const usedLabels = new Set(tasks.flatMap((t) => t.labelIds));
    const file: ProjectFile = {
      format: 'focus-project',
      formatVersion: 1,
      exportedAt: this.now().toISOString(),
      project: null,
      sections: [],
      labels: this.r.labels.list().filter((l) => usedLabels.has(l.id)).map((l) => ({ name: l.name, color: l.color })),
      tasks: this.toItems(tasks, new Map()).map((t) => (t.key === taskId ? { ...t, parentKey: null } : t)),
    };
    const slug = root.title.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'task';
    return { filename: `focus-task-${slug}.json`, text: JSON.stringify(file, null, 2) };
  }

  inspectProjectFile(text: string): ProjectFile {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ValidationError('This isn’t a Focus project or task file');
    }
    const parsed = projectFileSchema.safeParse(json);
    if (!parsed.success) throw new ValidationError('This isn’t a Focus project or task file (or it is damaged)');
    return parsed.data;
  }

  /**
   * Import a project file as a new project (named "… (imported)" if the name is taken),
   * or a task file into a chosen project (null = Inbox). Labels are matched by name.
   */
  importProjectFile(text: string, opts: { projectId?: string | null } = {}): ImportResult {
    const f = this.inspectProjectFile(text);
    const created: string[] = [];
    let projectId: string | null = opts.projectId ?? null;
    let result: ImportResult = { created: 0, taskIds: [], projectIds: [] };
    this.events.quietly(() =>
      this.r.db.transaction(() => {
        for (const l of f.labels) if (!this.r.labels.findByName(l.name)) this.svc.labels.create({ name: l.name, color: /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#64748b' });
        if (f.project && opts.projectId === undefined) {
          const taken = this.r.projects.list({ includeArchived: true }).some((p) => !p.parentId && p.name.toLowerCase() === f.project!.name.toLowerCase());
          const name = taken ? `${f.project.name} (imported)`.slice(0, 120) : f.project.name;
          projectId = this.svc.projects.create({
            name,
            description: f.project.description,
            notes: f.project.notes,
            color: /^#[0-9a-f]{6}$/i.test(f.project.color) ? f.project.color : '#64748b',
            icon: f.project.icon,
            layout: f.project.layout,
          }).id;
          created.push(projectId);
        }
        const sectionNames = new Map(f.sections.map((s) => [s.key, s.name]));
        const drafts: Draft[] = f.tasks.map((t, i) => ({
          line: i + 1,
          key: `file:${t.key}`,
          parentKey: t.parentKey ? `file:${t.parentKey}` : null,
          title: t.title,
          description: t.description,
          projectPath: null,
          section: t.sectionKey ? (sectionNames.get(t.sectionKey) ?? null) : null,
          priority: t.priority as Priority,
          status: t.status,
          labels: t.labels,
          startDate: t.startDate && ISO.test(t.startDate) ? t.startDate : null,
          scheduledDate: t.scheduledDate && ISO.test(t.scheduledDate) ? t.scheduledDate : null,
          scheduledTime: t.scheduledTime && TIME.test(t.scheduledTime) ? t.scheduledTime : null,
          deadline: t.deadline && ISO.test(t.deadline) ? t.deadline : null,
          durationMinutes: t.durationMinutes,
          recurrence: t.recurrence,
          recurrenceText: t.recurrenceText,
          completedAt: t.completedAt,
          comments: t.comments,
          existingId: null,
        }));
        result = this.commit(drafts, { projectId });
      }),
    );
    return { ...result, projectIds: [...created, ...result.projectIds] };
  }
}
