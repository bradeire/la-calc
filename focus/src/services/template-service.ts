import { todayISO } from '@/core/dates';
import { BUILT_IN_TEMPLATES, fromOffset, offset, templateSchema, type TemplateBody, type TemplateSummary } from '@/core/templates';
import type { Project, Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import { NotFoundError, ValidationError, type UndoAction } from './events';
import type { LabelService } from './label-service';
import type { ProjectService } from './project-service';
import type { TaskService } from './task-service';

export class TemplateService {
  constructor(
    private r: Repositories,
    private tasks: TaskService,
    private projects: ProjectService,
    private labels: LabelService,
  ) {}

  list(): TemplateSummary[] {
    const builtIns = BUILT_IN_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, builtIn: true, taskCount: t.body.tasks.length }));
    const own = this.r.templates.list().map((row) => {
      const body = this.parse(row.json);
      return { id: row.id, name: row.name, description: row.description, builtIn: false, taskCount: body?.tasks.length ?? 0 };
    });
    return [...own, ...builtIns];
  }

  private parse(json: string): TemplateBody | null {
    try {
      const r = templateSchema.safeParse(JSON.parse(json));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  getBody(id: string): TemplateBody {
    const builtIn = BUILT_IN_TEMPLATES.find((t) => t.id === id);
    if (builtIn) return builtIn.body;
    const row = this.r.templates.get(id);
    if (!row) throw new NotFoundError('That template');
    const body = this.parse(row.json);
    if (!body) throw new ValidationError('This template is damaged and cannot be used');
    return body;
  }

  /**
   * Capture a project as a template. Dates become offsets from the project's
   * earliest start/scheduled/deadline date. Completed tasks are included as open steps.
   */
  saveProjectAsTemplate(projectId: string, name: string, description = ''): string {
    const project = this.r.projects.get(projectId);
    if (!project || project.deletedAt) throw new NotFoundError('That project');
    const n = name.trim();
    if (!n) throw new ValidationError('A template needs a name');
    const tasks = this.r.tasks.listByProject(projectId, { includeClosed: true }).filter((t) => t.status !== 'cancelled' && t.status !== 'archived');
    const dates = tasks.flatMap((t) => [t.startDate, t.scheduledDate, t.deadline]).filter((d): d is string => !!d).sort();
    const base = dates[0] ?? todayISO();
    const sections = this.r.projects.listSections(projectId);
    const sectionName = new Map(sections.map((s) => [s.id, s.name]));
    const labelName = new Map(this.r.labels.list().map((l) => [l.id, l.name]));
    const ids = new Set(tasks.map((t) => t.id));
    const edges = this.r.dependencies.all().filter((e) => ids.has(e.taskId) && ids.has(e.dependsOnId));
    const body: TemplateBody = {
      v: 1,
      project: { color: project.color, icon: project.icon, layout: project.layout, description: project.description, notes: project.notes },
      sections: sections.map((s) => s.name),
      tasks: tasks.map((t: Task) => ({
        ref: t.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        section: t.sectionId ? (sectionName.get(t.sectionId) ?? null) : null,
        parentRef: t.parentId && ids.has(t.parentId) ? t.parentId : null,
        labels: t.labelIds.map((l) => labelName.get(l)).filter((x): x is string => !!x),
        startOffset: offset(t.startDate, base),
        scheduledOffset: offset(t.scheduledDate, base),
        scheduledTime: t.scheduledTime,
        deadlineOffset: offset(t.deadline, base),
        durationMinutes: t.durationMinutes,
        dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOnId),
        recurrence: t.recurrence,
        recurrenceText: t.recurrenceText,
      })),
    };
    const id = this.r.templates.insert(n, description, JSON.stringify(templateSchema.parse(body)));
    this.r.activity.log('project', projectId, 'template.saved', { templateId: id, name: n });
    return id;
  }

  /** Create a new project from a template in one transaction. */
  instantiate(templateId: string, opts: { name: string; startDate: string; parentId?: string | null }): Project {
    const body = this.getBody(templateId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startDate)) throw new ValidationError('Choose a valid start date');
    return this.r.db.transaction(() => {
      const project = this.projects.create({
        name: opts.name,
        color: body.project.color,
        icon: body.project.icon,
        layout: body.project.layout,
        description: body.project.description,
        notes: body.project.notes,
        parentId: opts.parentId ?? null,
      });
      const sectionIds = new Map<string, string>();
      for (const s of body.sections) sectionIds.set(s, this.projects.addSection(project.id, s));
      const labelNames = [...new Set(body.tasks.flatMap((t) => t.labels))];
      const ensured = this.labels.ensure(labelNames);
      const labelIds = new Map(labelNames.map((n, i) => [n, ensured[i]!]));

      // Parents before children; refuse templates whose parent links loop.
      const created = new Map<string, string>();
      let pending = [...body.tasks];
      while (pending.length) {
        const ready = pending.filter((t) => !t.parentRef || created.has(t.parentRef) || !body.tasks.some((x) => x.ref === t.parentRef));
        if (!ready.length) throw new ValidationError('This template has a loop in its subtasks');
        for (const t of ready) {
          const parentId = t.parentRef ? (created.get(t.parentRef) ?? null) : null;
          const task = this.tasks.create({
            title: t.title,
            description: t.description,
            priority: t.priority,
            projectId: project.id,
            sectionId: t.section ? (sectionIds.get(t.section) ?? null) : null,
            parentId,
            startDate: fromOffset(t.startOffset, opts.startDate),
            scheduledDate: fromOffset(t.scheduledOffset, opts.startDate),
            scheduledTime: t.scheduledOffset !== null ? t.scheduledTime : null,
            deadline: fromOffset(t.deadlineOffset, opts.startDate),
            durationMinutes: t.durationMinutes,
            labelIds: t.labels.map((n) => labelIds.get(n)!).filter(Boolean),
            recurrence: t.recurrence ? { ...t.recurrence, anchor: fromOffset(t.scheduledOffset, opts.startDate) ?? opts.startDate } : null,
            recurrenceText: t.recurrenceText,
          });
          created.set(t.ref, task.id);
        }
        pending = pending.filter((t) => !ready.includes(t));
      }
      for (const t of body.tasks) {
        for (const dep of t.dependsOn) {
          const a = created.get(t.ref);
          const b = created.get(dep);
          if (a && b) this.tasks.addDependency(a, b);
        }
      }
      this.r.activity.log('project', project.id, 'created.fromTemplate', { templateId });
      return project;
    });
  }

  remove(id: string): UndoAction {
    if (id.startsWith('builtin:')) throw new ValidationError('Built-in templates cannot be deleted');
    const row = this.r.templates.get(id);
    if (!row) throw new NotFoundError('That template');
    this.r.templates.softDelete(id);
    return { label: `Deleted template “${row.name}”`, undo: () => this.r.templates.softDelete(id, null) };
  }
}
