import { z } from 'zod';
import { projectInputSchema, projectPatchSchema, type Project, type ProjectInput } from '@/core/domain/types';
import type { Repositories } from '@/data';
import { nowIso } from '@/data/repositories/base';
import { EventBus, NotFoundError, ValidationError, type UndoAction } from './events';
import { toValidationError } from './task-service';


export class ProjectService {
  constructor(private r: Repositories, private events: EventBus) {}

  private must(id: string): Project {
    const p = this.r.projects.get(id);
    if (!p) throw new NotFoundError('That project');
    return p;
  }

  create(input: ProjectInput, opts: { isSample?: boolean } = {}): Project {
    let data: z.output<typeof projectInputSchema>;
    try {
      data = projectInputSchema.parse(input);
    } catch (e) {
      toValidationError(e);
    }
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        if (data.parentId) {
          const parent = this.r.projects.get(data.parentId);
          if (!parent || parent.deletedAt) throw new ValidationError('The parent project no longer exists', 'parentId');
        }
        const id = this.r.projects.insert({
          ...data,
          sortOrder: this.r.projects.nextSortOrder(data.parentId),
          isSample: opts.isSample ?? false,
        });
        this.r.activity.log('project', id, 'created', { name: data.name });
        this.events.emit({ type: 'project.created', projectId: id });
        return this.must(id);
      }),
    );
  }

  update(id: string, patch: Partial<ProjectInput> & { collapsed?: boolean; sortOrder?: number }): Project {
    let data: z.output<typeof projectPatchSchema>;
    try {
      data = projectPatchSchema.parse(patch);
    } catch (e) {
      toValidationError(e);
    }
    return this.r.db.transaction(() => {
      this.must(id);
      if (data.parentId) {
        if (data.parentId === id || this.r.projects.descendantIds(id).includes(data.parentId)) {
          throw new ValidationError('A project cannot be nested inside itself', 'parentId');
        }
        const parent = this.r.projects.get(data.parentId);
        if (!parent || parent.deletedAt) throw new ValidationError('The parent project no longer exists', 'parentId');
      }
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<Project>;
      if (patch.collapsed !== undefined) clean.collapsed = patch.collapsed;
      if (patch.sortOrder !== undefined) clean.sortOrder = patch.sortOrder;
      this.r.projects.update(id, clean);
      this.r.activity.log('project', id, 'updated', { fields: Object.keys(clean) });
      return this.must(id);
    });
  }

  archive(id: string): UndoAction {
    const p = this.must(id);
    const ts = nowIso();
    const ids = [id, ...this.r.projects.descendantIds(id)].filter((pid) => !this.r.projects.get(pid)?.archivedAt);
    this.r.db.transaction(() => {
      for (const pid of ids) this.r.projects.update(pid, { archivedAt: ts });
      this.r.activity.log('project', id, 'archived');
    });
    return {
      label: `Archived “${p.name}”`,
      undo: () => this.r.db.transaction(() => ids.forEach((pid) => this.r.projects.update(pid, { archivedAt: null }))),
    };
  }

  unarchive(id: string): void {
    this.r.db.transaction(() => {
      const p = this.must(id);
      const stamp = p.archivedAt;
      for (const pid of [id, ...this.r.projects.descendantIds(id)]) {
        if (this.r.projects.get(pid)?.archivedAt === stamp) this.r.projects.update(pid, { archivedAt: null });
      }
      // Un-archiving a child of an archived parent lifts it to the top level so it is visible.
      if (p.parentId && this.r.projects.get(p.parentId)?.archivedAt) this.r.projects.update(id, { parentId: null });
      this.r.activity.log('project', id, 'unarchived');
    });
  }

  /** Soft delete the project, its sub-projects, sections and tasks with one timestamp so they restore together. */
  remove(id: string): UndoAction {
    return this.r.db.transaction(() => {
      const p = this.must(id);
      const ts = nowIso();
      const projectIds = [id, ...this.r.projects.descendantIds(id)].filter((pid) => !this.r.projects.get(pid)?.deletedAt);
      const taskIds: string[] = [];
      const sectionIds: string[] = [];
      for (const pid of projectIds) {
        this.r.projects.update(pid, { deletedAt: ts });
        for (const s of this.r.projects.listSections(pid)) {
          this.r.projects.updateSection(s.id, { deletedAt: ts });
          sectionIds.push(s.id);
        }
        for (const t of this.r.tasks.listByProject(pid, { includeClosed: true })) {
          this.r.tasks.update(t.id, { deletedAt: ts });
          taskIds.push(t.id);
        }
      }
      this.r.activity.log('project', id, 'deleted', { tasks: taskIds.length });
      return {
        label: `Deleted “${p.name}”`,
        undo: () =>
          this.r.db.transaction(() => {
            projectIds.forEach((pid) => this.r.projects.update(pid, { deletedAt: null }));
            sectionIds.forEach((sid) => this.r.projects.updateSection(sid, { deletedAt: null }));
            taskIds.forEach((tid) => this.r.tasks.update(tid, { deletedAt: null }));
          }),
      };
    });
  }

  restore(id: string): void {
    this.r.db.transaction(() => {
      const p = this.must(id);
      const stamp = p.deletedAt;
      if (!stamp) return;
      for (const pid of [id, ...this.r.projects.descendantIds(id)]) {
        const q = this.r.projects.get(pid);
        if (q?.deletedAt !== stamp) continue;
        this.r.projects.update(pid, { deletedAt: null });
        this.r.db.run('UPDATE sections SET deleted_at = NULL WHERE project_id = ? AND deleted_at = ?', [pid, stamp]);
        for (const t of this.r.db.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ? AND deleted_at = ?', [pid, stamp])) {
          this.r.tasks.update(t.id, { deletedAt: null });
        }
      }
      if (p.parentId && this.r.projects.get(p.parentId)?.deletedAt) this.r.projects.update(id, { parentId: null });
      this.r.activity.log('project', id, 'restored');
    });
  }

  purge(id: string): void {
    this.r.db.transaction(() => {
      const p = this.must(id);
      if (!p.deletedAt) throw new ValidationError('Only projects in Trash can be permanently deleted');
      for (const pid of [...this.r.projects.descendantIds(id).reverse(), id]) this.r.projects.hardDelete(pid);
    });
  }

  // --- Sections ------------------------------------------------------------

  addSection(projectId: string, name: string): string {
    const n = name.trim();
    if (!n) throw new ValidationError('A section needs a name');
    if (n.length > 120) throw new ValidationError('Section names are limited to 120 characters');
    return this.r.db.transaction(() => {
      this.must(projectId);
      return this.r.projects.insertSection(projectId, n);
    });
  }

  renameSection(id: string, name: string): void {
    const n = name.trim();
    if (!n) throw new ValidationError('A section needs a name');
    this.r.projects.updateSection(id, { name: n });
  }

  /** Delete a section; its tasks are kept and moved to the project's unsectioned list. */
  removeSection(id: string): UndoAction {
    return this.r.db.transaction(() => {
      const s = this.r.projects.getSection(id);
      if (!s) throw new NotFoundError('That section');
      const moved = this.r.db.all<{ id: string }>('SELECT id FROM tasks WHERE section_id = ?', [id]).map((r) => r.id);
      for (const t of moved) this.r.tasks.update(t, { sectionId: null });
      this.r.projects.updateSection(id, { deletedAt: nowIso() });
      return {
        label: `Deleted section “${s.name}” (tasks kept)`,
        undo: () =>
          this.r.db.transaction(() => {
            this.r.projects.updateSection(id, { deletedAt: null });
            moved.forEach((t) => this.r.tasks.update(t, { sectionId: id }));
          }),
      };
    });
  }

  moveSection(id: string, direction: -1 | 1): void {
    this.r.db.transaction(() => {
      const s = this.r.projects.getSection(id);
      if (!s) return;
      const list = this.r.projects.listSections(s.projectId);
      const i = list.findIndex((x) => x.id === id);
      const j = i + direction;
      if (j < 0 || j >= list.length) return;
      const other = list[j]!;
      this.r.projects.updateSection(id, { sortOrder: other.sortOrder });
      this.r.projects.updateSection(other.id, { sortOrder: s.sortOrder });
    });
  }
}
