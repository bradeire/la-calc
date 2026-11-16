import { z } from 'zod';
import { applyFilter } from '@/core/filters/evaluate';
import { isOpenStatus, type Task } from '@/core/domain/types';
import { parseQuickAdd } from '@/core/nlp/parser';
import type { Repositories } from '@/data';
import type { AutomationService } from './automation-service';
import { ConfirmationRequired, NotFoundError, ValidationError } from './events';
import type { FilterService } from './filter-service';
import type { LabelService } from './label-service';
import type { ProjectService } from './project-service';
import type { QuickAddService } from './quick-add-service';
import type { TaskService } from './task-service';

export interface ApiRequest {
  method: string;
  path: string;
  query: string;
  body: string;
}
export interface ApiReply {
  status: number;
  body: unknown;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const createSchema = z
  .object({
    text: z.string().min(1).max(1000).optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(20000).optional(),
    projectId: z.string().uuid().nullable().optional(),
    project: z.string().max(120).optional(),
    parentId: z.string().uuid().optional(),
    priority: z.number().int().min(1).max(4).optional(),
    scheduledDate: isoDate.nullable().optional(),
    scheduledTime: isoTime.nullable().optional(),
    deadline: isoDate.nullable().optional(),
    durationMinutes: z.number().int().positive().max(43200).nullable().optional(),
    labels: z.array(z.string().min(1).max(60)).max(50).optional(),
  })
  .strict()
  .refine((b) => !!b.text !== !!b.title, 'Send either "text" (natural language, like Quick Add) or "title"');
const patchSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(20000),
    projectId: z.string().uuid().nullable(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    status: z.enum(['inbox', 'active', 'in_progress', 'waiting']),
    scheduledDate: isoDate.nullable(),
    scheduledTime: isoTime.nullable(),
    deadline: isoDate.nullable(),
    durationMinutes: z.number().int().positive().max(43200).nullable(),
    labels: z.array(z.string().min(1).max(60)).max(50),
  })
  .partial()
  .strict();
const projectSchema = z.object({ name: z.string().min(1).max(120), parentId: z.string().uuid().nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict();
const runSchema = z.object({ taskId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).strict();

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Local API request handling (spec 6.7). The Rust server has already checked the token,
 * Host, origin and size; this runs the request through the same services as the UI.
 * Deleting is deliberately not offered.
 */
export class ApiService {
  constructor(
    private r: Repositories,
    private svc: { tasks: TaskService; projects: ProjectService; labels: LabelService; quickAdd: QuickAddService; filters: FilterService; automations: AutomationService },
    private now: () => Date = () => new Date(),
  ) {}

  private taskJson(t: Task) {
    const labels = new Map(this.r.labels.list().map((l) => [l.id, l.name]));
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      projectId: t.projectId,
      project: t.projectId ? (this.r.projects.get(t.projectId)?.name ?? null) : null,
      parentId: t.parentId,
      priority: t.priority,
      status: t.status,
      startDate: t.startDate,
      scheduledDate: t.scheduledDate,
      scheduledTime: t.scheduledTime,
      deadline: t.deadline,
      durationMinutes: t.durationMinutes,
      labels: t.labelIds.map((id) => labels.get(id)).filter(Boolean),
      repeat: t.recurrenceText,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
    };
  }

  private json(body: string): unknown {
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
  }

  private parse<T>(schema: z.ZodType<T>, body: string): T {
    const r = schema.safeParse(this.json(body));
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    return r.data;
  }

  private task(id: string): Task {
    const t = this.r.tasks.get(id);
    if (!t || t.deletedAt) throw new HttpError(404, 'Task not found');
    return t;
  }

  private projectByName(name: string): string {
    const p = this.r.projects.list().find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!p) throw new HttpError(400, `No project called “${name}”`);
    return p.id;
  }

  handle(req: ApiRequest, approved: readonly string[] = []): ApiReply {
    try {
      return this.route(req, approved);
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      if (e instanceof ValidationError) return { status: 400, body: { error: e.message } };
      if (e instanceof NotFoundError) return { status: 404, body: { error: e.message } };
      if (e instanceof ConfirmationRequired) return { status: 409, body: { error: e.message, hint: 'Repeat with ?force=true to go ahead' } };
      console.error('API request failed', e);
      return { status: 500, body: { error: 'Something went wrong in Focus' } };
    }
  }

  private route(req: ApiRequest, approved: readonly string[]): ApiReply {
    const q = new URLSearchParams(req.query);
    const force = q.get('force') === 'true';
    const parts = req.path.replace(/^\/v1\//, '').split('/').filter(Boolean);
    const [res, id, action] = parts;
    const m = req.method;

    if (res === 'health' && m === 'GET') return { status: 200, body: { ok: true, app: 'Focus' } };

    if (res === 'tasks') {
      if (!id && m === 'GET') {
        let tasks = this.r.tasks.listForReports();
        const status = q.get('status') ?? 'open';
        if (status === 'open') tasks = tasks.filter((t) => isOpenStatus(t.status));
        else if (status === 'completed') tasks = tasks.filter((t) => t.status === 'completed');
        else if (status !== 'all') throw new HttpError(400, 'status must be open, completed or all');
        const project = q.get('projectId');
        if (project) tasks = tasks.filter((t) => t.projectId === project);
        const filter = q.get('filter');
        if (filter) {
          const parsed = this.svc.filters.parse(filter);
          if (!parsed.definition) throw new HttpError(400, `Filter: ${parsed.error}`);
          tasks = applyFilter(parsed.definition.root, tasks, this.svc.filters.context());
        }
        const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 1000);
        return { status: 200, body: { tasks: tasks.slice(0, limit).map((t) => this.taskJson(t)), total: tasks.length } };
      }
      if (!id && m === 'POST') {
        const b = this.parse(createSchema, req.body);
        let t: Task;
        if (b.text) {
          const ctx = { now: this.now(), projects: this.svc.filters.lookups().projects, labels: this.svc.filters.lookups().labels };
          t = this.svc.quickAdd.commit(parseQuickAdd(b.text, ctx), { projectId: b.projectId ?? undefined });
        } else {
          const projectId = b.project ? this.projectByName(b.project) : (b.projectId ?? null);
          t = this.svc.tasks.create({
            title: b.title!,
            description: b.description ?? '',
            projectId: b.parentId ? null : projectId,
            parentId: b.parentId ?? null,
            priority: (b.priority ?? 4) as 1 | 2 | 3 | 4,
            scheduledDate: b.scheduledDate ?? null,
            scheduledTime: b.scheduledTime ?? null,
            deadline: b.deadline ?? null,
            durationMinutes: b.durationMinutes ?? null,
            labelIds: b.labels ? this.svc.labels.ensure(b.labels) : [],
          });
        }
        return { status: 201, body: { task: this.taskJson(this.task(t.id)) } };
      }
      if (id && !action && m === 'GET') return { status: 200, body: { task: this.taskJson(this.task(id)) } };
      if (id && !action && m === 'PATCH') {
        this.task(id);
        const b = this.parse(patchSchema, req.body);
        const { labels, ...rest } = b;
        this.svc.tasks.update(id, { ...rest, ...(labels ? { labelIds: this.svc.labels.ensure(labels) } : {}) }, { force });
        return { status: 200, body: { task: this.taskJson(this.task(id)) } };
      }
      if (id && action === 'complete' && m === 'POST') {
        this.task(id);
        this.svc.tasks.complete(id, { force });
        return { status: 200, body: { task: this.taskJson(this.task(id)) } };
      }
      if (id && action === 'reopen' && m === 'POST') {
        this.task(id);
        this.svc.tasks.reopen(id);
        return { status: 200, body: { task: this.taskJson(this.task(id)) } };
      }
    }

    if (res === 'projects' && !id) {
      if (m === 'GET') {
        const stats = this.r.projects.stats();
        return {
          status: 200,
          body: { projects: this.r.projects.list().map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, color: p.color, openTasks: stats.get(p.id)?.open ?? 0 })) },
        };
      }
      if (m === 'POST') {
        const b = this.parse(projectSchema, req.body);
        const p = this.svc.projects.create({ name: b.name, parentId: b.parentId ?? null, ...(b.color ? { color: b.color } : {}) });
        return { status: 201, body: { project: { id: p.id, name: p.name, parentId: p.parentId, color: p.color } } };
      }
    }

    if (res === 'labels' && !id && m === 'GET') return { status: 200, body: { labels: this.r.labels.list().map((l) => ({ id: l.id, name: l.name, color: l.color })) } };

    if (res === 'automations') {
      const allowed = this.svc.automations.list().filter((a) => approved.includes(a.id) && a.enabled);
      if (!id && m === 'GET') return { status: 200, body: { automations: allowed.map((a) => ({ id: a.id, name: a.name, trigger: a.trigger.type })) } };
      if (id && action === 'run' && m === 'POST') {
        if (!allowed.some((a) => a.id === id)) throw new HttpError(403, 'This automation is not approved for the API (Settings → Local API)');
        const b = this.parse(runSchema, req.body);
        const r = this.svc.automations.runOnRequest(id, b);
        return { status: r.ran ? 200 : 409, body: r };
      }
    }

    throw new HttpError(404, 'Not found');
  }
}
