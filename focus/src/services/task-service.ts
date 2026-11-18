import { z } from 'zod';
import { todayISO } from '@/core/dates';
import { isOpenStatus, taskInputSchema, taskPatchSchema, STATUS_LABELS, type Task, type TaskInput, type TaskPatch, type TaskStatus } from '@/core/domain/types';
import { nextOccurrence } from '@/core/recurrence/engine';
import type { Repositories } from '@/data';
import { newId, nowIso } from '@/data/repositories/base';
import type { NewTaskRow } from '@/data/repositories/tasks';
import { ConfirmationRequired, EventBus, NotFoundError, ValidationError, type UndoAction } from './events';
import { formatRelativeDate } from '@/core/dates';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function toValidationError(err: unknown): never {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    throw new ValidationError(issue?.message ?? 'Invalid input', issue?.path.join('.'));
  }
  throw err;
}

export interface MoveTarget {
  projectId: string | null;
  sectionId?: string | null;
  parentId?: string | null;
}

/** Fields compared when logging an update to activity history. */
const TRACKED: (keyof Task)[] = [
  'title', 'description', 'projectId', 'sectionId', 'parentId', 'priority', 'status', 'startDate',
  'scheduledDate', 'scheduledTime', 'deadline', 'durationMinutes', 'pinnedToday',
];

export class TaskService {
  constructor(
    private r: Repositories,
    private events: EventBus,
    private clock: Clock = systemClock,
    private settings: () => { autoCompleteParent: boolean } = () => ({ autoCompleteParent: false }),
  ) {}

  private today() {
    return todayISO(this.clock.now());
  }

  private must(id: string): Task {
    const t = this.r.tasks.get(id);
    if (!t) throw new NotFoundError('That task');
    return t;
  }

  /** Validate project/section/parent references and derive the effective placement. */
  private resolvePlacement(projectId: string | null, sectionId: string | null, parentId: string | null, selfId?: string) {
    if (parentId) {
      const parent = this.r.tasks.get(parentId);
      if (!parent || parent.deletedAt) throw new ValidationError('The parent task no longer exists', 'parentId');
      if (selfId) {
        if (parentId === selfId) throw new ValidationError('A task cannot be its own subtask', 'parentId');
        if (this.r.tasks.descendantIds(selfId).includes(parentId)) {
          throw new ValidationError('A task cannot be moved under one of its own subtasks', 'parentId');
        }
      }
      // Subtasks always live in their parent's project and section.
      return { projectId: parent.projectId, sectionId: parent.sectionId, parentId };
    }
    if (projectId) {
      const p = this.r.projects.get(projectId);
      if (!p || p.deletedAt) throw new ValidationError('That project no longer exists', 'projectId');
    }
    if (sectionId) {
      const s = this.r.projects.getSection(sectionId);
      if (!s || s.deletedAt || s.projectId !== projectId) sectionId = null;
    }
    return { projectId, sectionId: projectId ? sectionId : null, parentId: null };
  }

  create(input: TaskInput, opts: { isSample?: boolean; id?: string } = {}): Task {
    let data: z.output<typeof taskInputSchema>;
    try {
      data = taskInputSchema.parse(input);
    } catch (e) {
      toValidationError(e);
    }
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        const place = this.resolvePlacement(data.projectId, data.sectionId, data.parentId);
        const status: TaskStatus = data.status ?? (place.projectId ? 'active' : 'inbox');
        const seriesId = data.recurrence ? newId() : null;
        const row: NewTaskRow = {
          id: opts.id,
          title: data.title,
          description: data.description,
          ...place,
          priority: data.priority,
          status,
          startDate: data.startDate,
          scheduledDate: data.scheduledDate,
          scheduledTime: data.scheduledDate ? data.scheduledTime : null,
          deadline: data.deadline,
          durationMinutes: data.durationMinutes,
          actualMinutes: 0,
          completedAt: status === 'completed' ? nowIso() : null,
          deletedAt: null,
          sortOrder: this.r.tasks.nextSortOrder(place.projectId, place.parentId),
          pinnedToday: data.pinnedToday,
          collapsed: false,
          seriesId,
          isSample: opts.isSample ?? false,
        };
        const id = this.r.tasks.insert(row);
        if (data.labelIds.length) this.r.tasks.setLabels(id, this.validLabels(data.labelIds));
        if (data.recurrence) this.r.tasks.setRecurrence(id, data.recurrence, data.recurrenceText);
        this.r.activity.log('task', id, 'created', { title: data.title });
        this.events.emit({ type: 'task.created', taskId: id });
        return this.must(id);
      }),
    );
  }

  private validLabels(ids: readonly string[]): string[] {
    return ids.filter((id) => {
      const l = this.r.labels.get(id);
      return l && !l.deletedAt;
    });
  }

  /** Open prerequisites of a task. */
  openPrerequisites(id: string): Task[] {
    return this.r.tasks.getMany(this.r.dependencies.prerequisitesOf(id)).filter((t) => isOpenStatus(t.status));
  }

  /**
   * Dependency order check for a proposed scheduled date (spec 4.4): a task should not be
   * planned before an unfinished prerequisite, nor a prerequisite after its dependants.
   */
  private checkScheduleOrder(id: string, date: string) {
    const today = this.today();
    for (const p of this.openPrerequisites(id)) {
      const pDate = p.scheduledDate ?? p.deadline;
      if (pDate && pDate > date) {
        throw new ConfirmationRequired(
          `This task depends on “${p.title}”, which is planned for ${formatRelativeDate(pDate, today)} — after the date you chose.`,
          'Schedule anyway',
        );
      }
    }
    for (const d of this.r.tasks.getMany(this.r.dependencies.dependentsOf(id))) {
      if (isOpenStatus(d.status) && d.scheduledDate && d.scheduledDate < date) {
        throw new ConfirmationRequired(
          `“${d.title}” depends on this task and is planned for ${formatRelativeDate(d.scheduledDate, today)} — before the date you chose.`,
          'Schedule anyway',
        );
      }
    }
  }

  update(id: string, patch: TaskPatch, opts: { force?: boolean } = {}): Task {
    let data: z.output<typeof taskPatchSchema>;
    try {
      data = taskPatchSchema.parse(patch);
    } catch (e) {
      toValidationError(e);
    }
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        const before = this.must(id);
        const changes: Partial<Task> = {};
        for (const [k, v] of Object.entries(data)) {
          if (v === undefined || k === 'labelIds' || k === 'recurrence' || k === 'recurrenceText') continue;
          (changes as Record<string, unknown>)[k] = v;
        }
        if ('projectId' in data || 'sectionId' in data || 'parentId' in data) {
          const place = this.resolvePlacement(
            data.projectId !== undefined ? data.projectId : before.projectId,
            data.sectionId !== undefined ? data.sectionId : data.projectId !== undefined && data.projectId !== before.projectId ? null : before.sectionId,
            data.parentId !== undefined ? data.parentId : before.parentId,
            id,
          );
          Object.assign(changes, place);
          if (place.projectId !== before.projectId || place.parentId !== before.parentId) {
            changes.sortOrder = this.r.tasks.nextSortOrder(place.projectId, place.parentId);
          }
        }
        if (changes.scheduledDate === null) changes.scheduledTime = null;
        if (changes.scheduledDate && changes.scheduledDate !== before.scheduledDate && !opts.force) {
          this.checkScheduleOrder(id, changes.scheduledDate);
        }
        if (changes.projectId !== undefined && changes.projectId !== before.projectId) {
          if (changes.projectId && before.status === 'inbox' && !changes.status) changes.status = 'active';
          if (!changes.projectId && before.status === 'active' && !changes.status) changes.status = 'inbox';
        }
        if (changes.status && changes.status !== before.status) {
          changes.completedAt = changes.status === 'completed' ? nowIso() : null;
        }
        this.r.tasks.update(id, changes);
        // Placement changes cascade to descendants.
        if (changes.projectId !== undefined || changes.sectionId !== undefined) {
          for (const d of this.r.tasks.descendantIds(id)) {
            this.r.tasks.update(d, {
              projectId: 'projectId' in changes ? changes.projectId : before.projectId,
              sectionId: 'sectionId' in changes ? changes.sectionId : before.sectionId,
            });
          }
        }
        if (data.labelIds) {
          const added = data.labelIds.filter((l) => !before.labelIds.includes(l));
          this.r.tasks.setLabels(id, this.validLabels(data.labelIds));
          for (const l of added) this.events.emit({ type: 'task.labelAdded', taskId: id, labelId: l });
        }
        if (data.recurrence !== undefined) {
          this.r.tasks.setRecurrence(id, data.recurrence, data.recurrenceText ?? null);
          if (data.recurrence && !before.seriesId) this.r.tasks.update(id, { seriesId: newId() });
        }
        const after = this.must(id);
        const changed = TRACKED.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
        if (changed.some((k) => k === 'scheduledDate' || k === 'scheduledTime' || k === 'deadline')) this.r.reminders.resetRelative(id);
        if (data.labelIds && before.labelIds.join() !== after.labelIds.join()) changed.push('labelIds');
        if (data.recurrence !== undefined && JSON.stringify(before.recurrence) !== JSON.stringify(after.recurrence)) changed.push('recurrence');
        if (changed.length) {
          const diff: Record<string, unknown> = {};
          for (const k of changed) diff[k] = { from: before[k], to: after[k] };
          this.r.activity.log('task', id, 'updated', diff);
          this.events.emit({ type: 'task.updated', taskId: id, changes: changed });
          if (changed.includes('priority')) this.events.emit({ type: 'task.priorityChanged', taskId: id, from: before.priority, to: after.priority });
          if (changed.includes('projectId')) this.events.emit({ type: 'task.moved', taskIds: [id], projectId: after.projectId });
        }
        return after;
      }),
    );
  }

  /**
   * Complete a task, its open subtasks, and — for recurring tasks — create the
   * next occurrence exactly once (ADR-005).
   */
  complete(id: string, opts: { force?: boolean } = {}): UndoAction {
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        const task = this.must(id);
        if (!isOpenStatus(task.status)) throw new ValidationError('That task is already closed');
        const blockers = opts.force ? [] : this.openPrerequisites(id);
        if (blockers.length) {
          const names = blockers.slice(0, 3).map((b) => `“${b.title}”`).join(', ');
          throw new ConfirmationRequired(
            `“${task.title}” is waiting on ${blockers.length} unfinished task${blockers.length > 1 ? 's' : ''}: ${names}${blockers.length > 3 ? '…' : ''}.`,
            'Complete anyway',
          );
        }
        const ts = nowIso();
        const today = this.today();
        const reopened: { id: string; status: TaskStatus }[] = [{ id, status: task.status }];
        this.r.tasks.update(id, { status: 'completed', completedAt: ts, pinnedToday: false });
        for (const d of this.r.tasks.getMany(this.r.tasks.descendantIds(id))) {
          if (isOpenStatus(d.status)) {
            reopened.push({ id: d.id, status: d.status });
            this.r.tasks.update(d.id, { status: 'completed', completedAt: ts });
          }
        }
        this.stopTimerFor(reopened.map((x) => x.id));

        let nextId: string | null = null;
        if (task.recurrence && task.seriesId && !this.r.tasks.openTaskInSeries(task.seriesId, id)) {
          const next = nextOccurrence({ rule: task.recurrence, scheduledDate: task.scheduledDate, completedOn: today, today });
          if (next) nextId = this.createNextOccurrence(task, next);
        }

        // Optional: complete ancestors whose subtasks are now all done.
        const autoParents: { id: string; status: TaskStatus }[] = [];
        if (this.settings().autoCompleteParent) {
          let parentId = task.parentId;
          while (parentId) {
            const parent = this.r.tasks.get(parentId);
            if (!parent || !isOpenStatus(parent.status)) break;
            const siblings = this.r.tasks.children(parentId);
            if (siblings.some((s) => isOpenStatus(s.status))) break;
            autoParents.push({ id: parent.id, status: parent.status });
            this.r.tasks.update(parent.id, { status: 'completed', completedAt: ts });
            this.r.activity.log('task', parent.id, 'completed', { auto: true });
            parentId = parent.parentId;
          }
        }

        this.r.activity.log('task', id, 'completed', nextId ? { nextOccurrenceId: nextId } : {});
        this.events.emit({ type: 'task.completed', taskId: id, nextId });
        // Last open task in its project: the project is complete (automations can react).
        if (task.projectId && !nextId && this.r.tasks.listByProject(task.projectId).length === 0) {
          this.events.emit({ type: 'project.completed', projectId: task.projectId });
        }
        for (const p of autoParents) this.events.emit({ type: 'task.completed', taskId: p.id, nextId: null });

        return {
          label: `Completed “${task.title}”`,
          undo: () =>
            this.r.db.transaction(() => {
              for (const t of [...reopened, ...autoParents]) this.r.tasks.update(t.id, { status: t.status, completedAt: null });
              this.r.tasks.update(id, { pinnedToday: task.pinnedToday });
              if (nextId) {
                const created = this.r.tasks.get(nextId);
                // Only remove the generated occurrence if the user has not touched it since.
                if (created && !created.deletedAt && created.updatedAt === created.createdAt) {
                  this.r.tasks.hardDelete([...this.r.tasks.descendantIds(nextId, { includeDeleted: true }).reverse(), nextId]);
                }
              }
              this.r.activity.log('task', id, 'reopened', { undo: true });
            }),
        };
      }),
    );
  }

  private createNextOccurrence(task: Task, date: string): string {
    const shift = (d: string | null) => {
      if (!d || !task.scheduledDate) return d;
      const delta = (Date.parse(d) - Date.parse(task.scheduledDate)) / 86400000;
      const base = new Date(Date.parse(date + 'T00:00:00Z') + delta * 86400000);
      return base.toISOString().slice(0, 10);
    };
    const copy = (src: Task, parentId: string | null, isRoot: boolean): string => {
      const newIdValue = this.r.tasks.insert({
        title: src.title,
        description: src.description,
        projectId: src.projectId,
        sectionId: src.sectionId,
        parentId,
        priority: src.priority,
        status: src.projectId ? 'active' : 'inbox',
        startDate: isRoot ? shift(src.startDate) : null,
        scheduledDate: isRoot ? date : null,
        scheduledTime: isRoot ? src.scheduledTime : null,
        deadline: isRoot ? shift(src.deadline) : null,
        durationMinutes: src.durationMinutes,
        actualMinutes: 0,
        completedAt: null,
        deletedAt: null,
        sortOrder: src.sortOrder,
        pinnedToday: false,
        collapsed: src.collapsed,
        seriesId: isRoot ? src.seriesId : null,
        isSample: src.isSample,
      });
      if (src.labelIds.length) this.r.tasks.setLabels(newIdValue, src.labelIds);
      for (const child of this.r.tasks.children(src.id)) {
        if (child.status !== 'cancelled' && child.status !== 'archived') copy(child, newIdValue, false);
      }
      return newIdValue;
    };
    const id = copy(task, task.parentId, true);
    this.r.tasks.setRecurrence(id, task.recurrence, task.recurrenceText);
    // Reminders repeat with the task: relative ones as-is, absolute ones shifted by the same number of days.
    const shiftDays = task.scheduledDate ? Math.round((Date.parse(date) - Date.parse(task.scheduledDate)) / 86400000) : 0;
    for (const rem of this.r.reminders.listForTask(task.id)) {
      if (rem.kind === 'relative') this.r.reminders.insert({ taskId: id, kind: 'relative', offsetMinutes: rem.offsetMinutes });
      else if (rem.remindAt && shiftDays) {
        const at = new Date(rem.remindAt);
        at.setDate(at.getDate() + shiftDays); // local-calendar shift keeps the wall-clock time across DST
        this.r.reminders.insert({ taskId: id, kind: 'absolute', remindAt: at.toISOString() });
      }
    }
    this.r.activity.log('task', id, 'created', { recurrenceOf: task.id, scheduledDate: date });
    return id;
  }

  reopen(id: string): UndoAction {
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        const task = this.must(id);
        if (isOpenStatus(task.status)) throw new ValidationError('That task is already open');
        const prev = { status: task.status, completedAt: task.completedAt };
        this.r.tasks.update(id, { status: task.projectId ? 'active' : 'inbox', completedAt: null });
        // A reopened subtask reopens closed ancestors so it is visible again.
        const ancestors = this.r.tasks.ancestors(id).filter((a) => !isOpenStatus(a.status));
        for (const a of ancestors) this.r.tasks.update(a.id, { status: a.projectId ? 'active' : 'inbox', completedAt: null });
        this.r.activity.log('task', id, 'reopened');
        this.events.emit({ type: 'task.reopened', taskId: id });
        return {
          label: `Reopened “${task.title}”`,
          undo: () =>
            this.r.db.transaction(() => {
              this.r.tasks.update(id, prev);
              for (const a of ancestors) this.r.tasks.update(a.id, { status: a.status, completedAt: a.completedAt });
            }),
        };
      }),
    );
  }

  setStatus(id: string, status: TaskStatus): UndoAction | null {
    const task = this.must(id);
    if (status === task.status) return null;
    if (status === 'completed') return this.complete(id);
    if (!isOpenStatus(task.status) && isOpenStatus(status)) {
      const undo = this.reopen(id);
      if (status !== (task.projectId ? 'active' : 'inbox')) this.update(id, { status });
      return undo;
    }
    const prev = task.status;
    this.update(id, { status });
    return { label: `Marked “${task.title}” ${STATUS_LABELS[status].toLowerCase()}`, undo: () => this.update(id, { status: prev }) };
  }

  /** Soft delete tasks and their subtasks together; restorable from Trash. */
  remove(ids: readonly string[]): UndoAction {
    return this.events.batch(() =>
      this.r.db.transaction(() => {
        const ts = nowIso();
        const all = new Set<string>();
        for (const id of ids) {
          const t = this.must(id);
          if (t.deletedAt) continue;
          all.add(id);
          for (const d of this.r.tasks.descendantIds(id)) all.add(d);
        }
        for (const id of all) this.r.tasks.update(id, { deletedAt: ts });
        this.stopTimerFor([...all]);
        for (const id of ids) this.r.activity.log('task', id, 'deleted');
        this.events.emit({ type: 'task.deleted', taskIds: [...all] });
        const n = ids.length;
        const first = n === 1 ? this.r.tasks.get(ids[0]!)?.title : null;
        return {
          label: first ? `Deleted “${first}”` : `Deleted ${n} tasks`,
          undo: () =>
            this.r.db.transaction(() => {
              for (const id of all) this.r.tasks.update(id, { deletedAt: null });
            }),
        };
      }),
    );
  }

  /** Restore a task from Trash with the subtasks deleted alongside it. */
  restore(id: string): void {
    this.r.db.transaction(() => {
      const t = this.must(id);
      if (!t.deletedAt) return;
      const stamp = t.deletedAt;
      const ids = [id, ...this.r.tasks.descendantIds(id, { includeDeleted: true })];
      for (const tid of ids) {
        const x = this.r.tasks.get(tid);
        if (x?.deletedAt === stamp) this.r.tasks.update(tid, { deletedAt: null });
      }
      // If the parent or project is gone, restore into the Inbox / top level rather than hiding the task.
      if (t.parentId && this.r.tasks.get(t.parentId)?.deletedAt) this.r.tasks.update(id, { parentId: null });
      if (t.projectId) {
        const p = this.r.projects.get(t.projectId);
        if (!p || p.deletedAt) {
          for (const tid of ids) this.r.tasks.update(tid, { projectId: null, sectionId: null });
          this.r.tasks.update(id, { status: isOpenStatus(t.status) ? 'inbox' : t.status });
        }
      }
      this.r.activity.log('task', id, 'restored');
    });
  }

  /** Permanently delete. Only offered from Trash, after confirmation. */
  purge(id: string): void {
    this.r.db.transaction(() => {
      const t = this.must(id);
      if (!t.deletedAt) throw new ValidationError('Only tasks in Trash can be permanently deleted');
      this.r.tasks.hardDelete([id]);
    });
  }

  duplicate(id: string): Task {
    return this.r.db.transaction(() => {
      const src = this.must(id);
      const copy = (s: Task, parentId: string | null, isRoot: boolean): string => {
        const nid = this.r.tasks.insert({
          ...s,
          id: undefined,
          createdAt: undefined,
          title: isRoot ? `${s.title} (copy)` : s.title,
          parentId,
          status: isOpenStatus(s.status) ? s.status : s.projectId ? 'active' : 'inbox',
          completedAt: null,
          actualMinutes: 0,
          sortOrder: isRoot ? s.sortOrder + 0.5 : s.sortOrder,
          seriesId: s.recurrence ? newId() : null,
        });
        if (s.labelIds.length) this.r.tasks.setLabels(nid, s.labelIds);
        if (s.recurrence) this.r.tasks.setRecurrence(nid, s.recurrence, s.recurrenceText);
        for (const c of this.r.tasks.children(s.id)) copy(c, nid, false);
        return nid;
      };
      const nid = copy(src, src.parentId, true);
      this.r.activity.log('task', nid, 'created', { duplicateOf: id });
      return this.must(nid);
    });
  }

  move(ids: readonly string[], target: MoveTarget): UndoAction {
    return this.r.db.transaction(() => {
      const before = ids.map((id) => {
        const t = this.must(id);
        return { id, projectId: t.projectId, sectionId: t.sectionId, parentId: t.parentId, status: t.status };
      });
      for (const id of ids) {
        this.update(id, {
          projectId: target.projectId,
          sectionId: target.sectionId ?? null,
          parentId: target.parentId ?? null,
        });
      }
      return {
        label: ids.length === 1 ? 'Task moved' : `${ids.length} tasks moved`,
        undo: () =>
          this.r.db.transaction(() => {
            for (const b of before) this.update(b.id, { projectId: b.projectId, sectionId: b.sectionId, parentId: b.parentId, status: b.status });
          }),
      };
    });
  }

  /** Make a subtask an independent task in the same project and section. */
  promote(id: string): UndoAction {
    const t = this.must(id);
    if (!t.parentId) throw new ValidationError('This is already a top-level task');
    return this.move([id], { projectId: t.projectId, sectionId: t.sectionId, parentId: null });
  }

  /** Reorder within siblings: place `id` immediately before `beforeId` (or at the end when null). */
  reorder(id: string, beforeId: string | null, siblings: readonly Task[]): void {
    const list = siblings.filter((s) => s.id !== id);
    const idx = beforeId ? list.findIndex((s) => s.id === beforeId) : list.length;
    const prev = list[idx - 1]?.sortOrder;
    const next = list[idx]?.sortOrder;
    let order: number;
    if (prev === undefined && next === undefined) order = 1;
    else if (prev === undefined) order = next! - 1;
    else if (next === undefined) order = prev + 1;
    else order = (prev + next) / 2;
    this.r.tasks.update(id, { sortOrder: order });
  }

  bulkUpdate(ids: readonly string[], patch: TaskPatch, opts: { force?: boolean } = {}): UndoAction {
    return this.r.db.transaction(() => {
      const before = this.r.tasks.getMany(ids);
      for (const id of ids) this.update(id, patch, opts);
      return {
        label: `Updated ${ids.length} tasks`,
        undo: () =>
          this.r.db.transaction(() => {
            for (const b of before) {
              const restore: TaskPatch = {};
              for (const k of Object.keys(patch) as (keyof TaskPatch)[]) (restore as Record<string, unknown>)[k] = b[k as keyof Task];
              this.update(b.id, restore, { force: true });
            }
          }),
      };
    });
  }

  bulkComplete(ids: readonly string[], opts: { force?: boolean } = {}): UndoAction {
    return this.r.db.transaction(() => {
      // Skip tasks closed by an earlier completion in this batch (e.g. a selected subtask of a selected parent).
      const undos: UndoAction[] = [];
      for (const id of ids) {
        const t = this.r.tasks.get(id);
        if (t && isOpenStatus(t.status)) undos.push(this.complete(id, opts));
      }
      return {
        label: `Completed ${undos.length} tasks`,
        undo: () => this.r.db.transaction(() => [...undos].reverse().forEach((u) => u.undo())),
      };
    });
  }

  // --- Dependencies (spec 4.4) ---------------------------------------------

  /** `taskId` cannot be finished before `dependsOnId`. Rejects self-links and cycles. */
  addDependency(taskId: string, dependsOnId: string): UndoAction {
    return this.r.db.transaction(() => {
      const task = this.must(taskId);
      const pre = this.must(dependsOnId);
      if (taskId === dependsOnId) throw new ValidationError('A task cannot depend on itself');
      if (task.deletedAt || pre.deletedAt) throw new ValidationError('That task is in Trash');
      if (this.r.dependencies.reaches(dependsOnId, taskId)) {
        throw new ValidationError(`That would create a circular dependency: “${pre.title}” already depends on “${task.title}”, directly or indirectly.`);
      }
      this.r.dependencies.add(taskId, dependsOnId);
      this.r.activity.log('task', taskId, 'dependency.added', { dependsOn: dependsOnId, title: pre.title });
      return {
        label: `“${task.title}” now waits for “${pre.title}”`,
        undo: () => this.r.db.transaction(() => this.r.dependencies.remove(taskId, dependsOnId)),
      };
    });
  }

  removeDependency(taskId: string, dependsOnId: string): UndoAction {
    return this.r.db.transaction(() => {
      this.r.dependencies.remove(taskId, dependsOnId);
      this.r.activity.log('task', taskId, 'dependency.removed', { dependsOn: dependsOnId });
      return { label: 'Dependency removed', undo: () => this.r.db.transaction(() => this.r.dependencies.add(taskId, dependsOnId)) };
    });
  }

  // --- Time tracking -------------------------------------------------------

  startTimer(taskId: string): void {
    this.r.db.transaction(() => {
      this.must(taskId);
      const running = this.r.time.running();
      if (running?.taskId === taskId) return;
      if (running) this.stopTimer();
      this.r.time.start(taskId);
      const t = this.must(taskId);
      if (t.status === 'active' || t.status === 'inbox') this.r.tasks.update(taskId, { status: 'in_progress' });
      this.r.activity.log('task', taskId, 'timer.started');
    });
  }

  stopTimer(): number {
    return this.r.db.transaction(() => {
      const running = this.r.time.running();
      if (!running) return 0;
      const minutes = this.r.time.stop(running.id);
      this.r.tasks.update(running.taskId, { actualMinutes: this.r.time.totalMinutes(running.taskId) });
      this.r.activity.log('task', running.taskId, 'timer.stopped', { minutes });
      return minutes;
    });
  }

  /** Returns the task's new total of tracked minutes. */
  addManualTime(taskId: string, minutes: number, startedAt = nowIso(), note = ''): number {
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) throw new ValidationError('Enter between 1 and 1440 minutes');
    return this.r.db.transaction(() => {
      this.must(taskId);
      this.r.time.addManual(taskId, startedAt, minutes, note);
      const total = this.r.time.totalMinutes(taskId);
      this.r.tasks.update(taskId, { actualMinutes: total });
      return total;
    });
  }

  /**
   * Stop the running timer at an earlier moment, e.g. when it was left running
   * (an active timer does not mean the user was working).
   */
  stopTimerAt(endIso: string): number {
    return this.r.db.transaction(() => {
      const running = this.r.time.running();
      if (!running) return 0;
      const end = Date.parse(endIso);
      if (!Number.isFinite(end) || end < Date.parse(running.startedAt)) throw new ValidationError('The end must be after the timer started');
      if (end > Date.now() + 60_000) throw new ValidationError('The end can’t be in the future');
      const minutes = this.r.time.stop(running.id, new Date(end).toISOString());
      this.r.tasks.update(running.taskId, { actualMinutes: this.r.time.totalMinutes(running.taskId) });
      this.r.activity.log('task', running.taskId, 'timer.stopped', { minutes, trimmed: true });
      return minutes;
    });
  }

  /** Correct a time log entry (spec 6.2). */
  correctTimeEntry(entryId: string, patch: { startedAt: string; minutes: number; note?: string }): void {
    if (!Number.isInteger(patch.minutes) || patch.minutes <= 0 || patch.minutes > 24 * 60) throw new ValidationError('Enter between 1 and 1440 minutes');
    if (!Number.isFinite(Date.parse(patch.startedAt))) throw new ValidationError('Enter a valid start time');
    this.r.db.transaction(() => {
      const e = this.r.time.get(entryId);
      if (!e || e.deletedAt) throw new ValidationError('Time entry not found');
      if (e.endedAt === null) throw new ValidationError('Stop the timer before correcting it');
      this.r.time.correct(entryId, { startedAt: new Date(patch.startedAt).toISOString(), minutes: patch.minutes, note: patch.note ?? e.note });
      this.r.tasks.update(e.taskId, { actualMinutes: this.r.time.totalMinutes(e.taskId) });
      this.r.activity.log('task', e.taskId, 'time.corrected', { entryId, minutes: patch.minutes });
    });
  }

  deleteTimeEntry(entryId: string): void {
    this.r.db.transaction(() => {
      const e = this.r.time.get(entryId);
      if (!e) return;
      this.r.time.softDelete(entryId);
      this.r.tasks.update(e.taskId, { actualMinutes: this.r.time.totalMinutes(e.taskId) });
    });
  }

  private stopTimerFor(taskIds: readonly string[]) {
    const running = this.r.time.running();
    if (running && taskIds.includes(running.taskId)) this.stopTimer();
  }
}
