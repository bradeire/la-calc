import { addDays, todayISO } from '@/core/dates';
import {
  automationInputSchema, PROJECT_TRIGGERS, renderTemplate, TIME_TRIGGERS,
  type Automation, type AutomationAction, type AutomationInput, type AutomationRun, type TriggerType,
} from '@/core/automation/types';
import { evaluate, type FilterContext } from '@/core/filters/evaluate';
import { isOpenStatus, STATUS_LABELS, type Priority, type Project, type Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import type { ContentService } from './content-service';
import { NotFoundError, ValidationError, type DomainEvent, type EventBus, type UndoAction } from './events';
import type { FilterService } from './filter-service';
import type { ProjectService } from './project-service';
import type { TaskService } from './task-service';
import type { TemplateService } from './template-service';
import type { WebhookService } from './webhook-service';
import { toValidationError, type Clock } from './task-service';

const MAX_CHAIN_DEPTH = 3;
const MAX_FIRES_PER_SWEEP = 50;

interface FireContext {
  trigger: TriggerType;
  task?: Task;
  project?: Project;
  eventKey: string;
}

export interface TestResult {
  matches: boolean;
  reason: string;
  actions: string[];
}

/**
 * Rule engine (spec 5.4). Reacts to domain events and to a periodic sweep for
 * time-based triggers. Safeguards: duplicate prevention (one run per automation
 * per event key, enforced by a UNIQUE index), per-automation hourly limits,
 * loop prevention (an automation cannot re-trigger itself through its own
 * actions; chains stop at depth 3), transactional actions, and a run history
 * with errors.
 */
export class AutomationService {
  private chain: string[] = [];
  private notifier: (title: string, body: string) => void = () => {};
  private filterCtx: FilterContext | null = null;
  private off: () => void;

  constructor(
    private r: Repositories,
    events: EventBus,
    private svc: { tasks: TaskService; projects: ProjectService; content: ContentService; templates: TemplateService; webhooks: WebhookService; filters: FilterService },
    private clock: Clock,
  ) {
    this.off = events.on((e) => this.onEvent(e));
  }

  dispose() {
    this.off();
  }

  /** The UI provides how "notify" actions reach the user (in-app + system notification). */
  setNotifier(fn: (title: string, body: string) => void) {
    this.notifier = fn;
  }

  // --- CRUD ------------------------------------------------------------------

  list(): Automation[] {
    return this.r.automations.list();
  }

  save(input: AutomationInput, id?: string): string {
    let def;
    try {
      def = automationInputSchema.parse(input);
    } catch (e) {
      toValidationError(e);
    }
    this.validateReferences(def.actions);
    if (id) {
      if (!this.r.automations.get(id)) throw new NotFoundError('That automation');
      this.r.automations.update(id, def);
      return id;
    }
    return this.r.automations.insert(def);
  }

  setEnabled(id: string, enabled: boolean): true {
    this.r.automations.setEnabled(id, enabled);
    return true;
  }

  remove(id: string): UndoAction {
    const a = this.r.automations.get(id);
    if (!a) throw new NotFoundError('That automation');
    this.r.automations.softDelete(id);
    return { label: `Deleted automation “${a.name}”`, undo: () => this.r.automations.softDelete(id, null) };
  }

  runs(automationId?: string, limit = 100): AutomationRun[] {
    return this.r.automations.listRuns(automationId, limit);
  }

  private validateReferences(actions: readonly AutomationAction[]) {
    for (const a of actions) {
      if ((a.type === 'addLabel' || a.type === 'removeLabel') && !this.r.labels.get(a.labelId)) throw new ValidationError('An action refers to a label that no longer exists');
      if (a.type === 'moveToProject' && a.projectId && !this.r.projects.get(a.projectId)) throw new ValidationError('An action refers to a project that no longer exists');
      if (a.type === 'webhook' && !this.r.integrations.getWebhook(a.webhookId)) throw new ValidationError('An action refers to a webhook that no longer exists');
    }
  }

  // --- Matching ----------------------------------------------------------------

  private today() {
    return todayISO(this.clock.now());
  }

  private ctxFilter(): FilterContext {
    return (this.filterCtx ??= this.svc.filters.context());
  }

  private matches(a: Automation, f: FireContext, extra: { labelId?: string } = {}): { ok: boolean; reason: string } {
    if (a.trigger.type !== f.trigger) return { ok: false, reason: 'Different trigger' };
    if (a.trigger.labelId && extra.labelId !== a.trigger.labelId) return { ok: false, reason: 'A different label was added' };
    if (PROJECT_TRIGGERS.includes(f.trigger)) {
      const needle = a.trigger.nameContains?.trim().toLowerCase();
      if (needle && !f.project?.name.toLowerCase().includes(needle)) return { ok: false, reason: `Project name does not contain “${a.trigger.nameContains}”` };
      return { ok: true, reason: 'Trigger matched' };
    }
    if (!f.task) return { ok: false, reason: 'No task' };
    if (a.conditions && !evaluate(a.conditions.root, f.task, this.ctxFilter())) return { ok: false, reason: 'Task does not meet the conditions' };
    return { ok: true, reason: 'Trigger and conditions matched' };
  }

  private onEvent(e: DomainEvent) {
    const automations = this.list().filter((a) => a.enabled && !TIME_TRIGGERS.includes(a.trigger.type));
    if (!automations.length) return;
    this.filterCtx = null;
    const task = (id: string) => this.r.tasks.get(id);
    const fires: { f: FireContext; extra?: { labelId?: string } }[] = [];
    switch (e.type) {
      case 'task.created': {
        const t = task(e.taskId);
        if (t) fires.push({ f: { trigger: 'task.created', task: t, eventKey: `created:${t.id}` } });
        break;
      }
      case 'task.completed': {
        const t = task(e.taskId);
        if (!t) break;
        fires.push({ f: { trigger: 'task.completed', task: t, eventKey: `completed:${t.id}:${t.completedAt}` } });
        if (t.parentId) fires.push({ f: { trigger: 'subtask.completed', task: t, eventKey: `subtask:${t.id}:${t.completedAt}` } });
        break;
      }
      case 'task.priorityChanged': {
        const t = task(e.taskId);
        if (t) fires.push({ f: { trigger: 'task.priorityChanged', task: t, eventKey: `priority:${t.id}:${e.to}:${t.updatedAt}` } });
        break;
      }
      case 'task.labelAdded': {
        const t = task(e.taskId);
        if (t) fires.push({ f: { trigger: 'task.labelAdded', task: t, eventKey: `label:${t.id}:${e.labelId}:${t.updatedAt}` }, extra: { labelId: e.labelId } });
        break;
      }
      case 'task.moved':
        for (const id of e.taskIds) {
          const t = task(id);
          if (t) fires.push({ f: { trigger: 'task.moved', task: t, eventKey: `moved:${t.id}:${e.projectId}:${t.updatedAt}` } });
        }
        break;
      case 'project.created': {
        const p = this.r.projects.get(e.projectId);
        if (p) fires.push({ f: { trigger: 'project.created', project: p, eventKey: `project-created:${p.id}` } });
        break;
      }
      case 'project.completed': {
        const p = this.r.projects.get(e.projectId);
        if (p) fires.push({ f: { trigger: 'project.completed', project: p, eventKey: `project-completed:${p.id}:${this.clock.now().toISOString().slice(0, 16)}` } });
        break;
      }
      default:
        return;
    }
    for (const { f, extra } of fires) {
      for (const a of automations) if (this.matches(a, f, extra).ok) this.fire(a, f);
    }
  }

  /** Time-based triggers. Called once a minute and at start-up; duplicate keys stop repeats. */
  sweep(): number {
    const automations = this.list().filter((a) => a.enabled && TIME_TRIGGERS.includes(a.trigger.type));
    if (!automations.length) return 0;
    this.filterCtx = null;
    const now = this.clock.now();
    const today = this.today();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const open = this.r.tasks.listForFilters().filter((t) => isOpenStatus(t.status));
    let fired = 0;
    for (const a of automations) {
      let count = 0;
      for (const t of open) {
        if (count >= MAX_FIRES_PER_SWEEP) break;
        let key: string | null = null;
        switch (a.trigger.type) {
          case 'task.overdue':
            if ((t.scheduledDate && t.scheduledDate < today) || (t.deadline && t.deadline < today)) key = `overdue:${t.id}:${t.scheduledDate}:${t.deadline}`;
            break;
          case 'deadline.approaching': {
            const days = a.trigger.days ?? 1;
            if (t.deadline && t.deadline >= today && t.deadline <= addDays(today, days)) key = `deadline:${t.id}:${t.deadline}:${days}`;
            break;
          }
          case 'scheduled.reached':
            if (t.scheduledDate === today && (!t.scheduledTime || t.scheduledTime <= hhmm)) key = `reached:${t.id}:${t.scheduledDate}:${t.scheduledTime}`;
            break;
          case 'task.waitingTooLong': {
            if (t.status !== 'waiting') break;
            const since = this.waitingSince(t);
            if (Date.parse(since) <= now.getTime() - (a.trigger.days ?? 3) * 86400000) key = `waiting:${t.id}:${since}`;
            break;
          }
          default:
            break;
        }
        if (!key) continue;
        const f: FireContext = { trigger: a.trigger.type, task: t, eventKey: key };
        if (this.matches(a, f).ok && this.fire(a, f)) {
          count++;
          fired++;
        }
      }
    }
    return fired;
  }

  private waitingSince(t: Task): string {
    const row = this.r.db.get<{ at: string }>(
      `SELECT created_at AS at FROM activity_log WHERE entity_id = ? AND action = 'updated'
       AND json_extract(payload_json, '$.status.to') = 'waiting' ORDER BY created_at DESC LIMIT 1`,
      [t.id],
    );
    return row?.at ?? t.createdAt;
  }

  // --- Execution ---------------------------------------------------------------

  /** Returns true if the automation ran (false if skipped, duplicate or failed). */
  /**
   * Run an automation on request (local API, spec 6.7). Its conditions, limits, duplicate and
   * loop protection all still apply. Task triggers need a task; project triggers a project.
   */
  runOnRequest(id: string, target: { taskId?: string; projectId?: string } = {}): { ran: boolean; reason: string } {
    const a = this.r.automations.get(id);
    if (!a || !a.enabled) throw new NotFoundError('Automation');
    const isProject = PROJECT_TRIGGERS.includes(a.trigger.type);
    const task = target.taskId ? this.r.tasks.get(target.taskId) : undefined;
    const project = target.projectId ? this.r.projects.get(target.projectId) : undefined;
    if (isProject && !project) throw new ValidationError('This automation needs a projectId');
    if (!isProject && !task) throw new ValidationError('This automation needs a taskId');
    const f: FireContext = { trigger: a.trigger.type, task, project, eventKey: `request:${this.clock.now().toISOString()}:${Math.random().toString(36).slice(2, 8)}` };
    const m = this.matches(a, f);
    if (!m.ok) return { ran: false, reason: m.reason };
    const ran = this.fire(a, f);
    return { ran, reason: ran ? 'Ran' : 'Skipped (see run history)' };
  }

  private fire(a: Automation, f: FireContext): boolean {
    if (this.chain.includes(a.id)) return this.skip(a, f, 'Skipped to prevent a loop: this automation triggered itself');
    if (this.chain.length >= MAX_CHAIN_DEPTH) return this.skip(a, f, `Skipped: automations chained more than ${MAX_CHAIN_DEPTH} deep`);
    const hourAgo = new Date(this.clock.now().getTime() - 3600_000).toISOString();
    if (this.r.automations.runsSince(a.id, hourAgo) >= a.maxRunsPerHour) return this.skip(a, f, `Skipped: limit of ${a.maxRunsPerHour} runs per hour reached`);
    const runId = this.r.automations.startRun(a.id, f.eventKey, { trigger: f.trigger, taskId: f.task?.id, projectId: f.project?.id });
    if (!runId) return false; // already ran for this event
    this.chain.push(a.id);
    const pending: { label: string; run: () => Promise<unknown> }[] = [];
    const done: string[] = [];
    try {
      this.r.db.transaction(() => {
        for (const action of a.actions) done.push(this.apply(action, f, a, pending));
      });
      this.r.automations.finishRun(runId, 'succeeded', null, { trigger: f.trigger, taskId: f.task?.id, actions: done });
    } catch (err) {
      this.r.automations.finishRun(runId, 'failed', (err as Error).message, { trigger: f.trigger, taskId: f.task?.id, actions: done });
      console.warn(`Automation “${a.name}” failed`, err);
      return false;
    } finally {
      this.chain.pop();
    }
    // Network actions run after the data changes are committed; failures are recorded on the run.
    for (const p of pending) {
      p.run().catch((err: unknown) => this.r.automations.finishRun(runId, 'failed', `${p.label}: ${(err as Error).message}`, { trigger: f.trigger, taskId: f.task?.id, actions: done }));
    }
    return true;
  }

  private skip(a: Automation, f: FireContext, reason: string): boolean {
    const id = this.r.automations.startRun(a.id, `${f.eventKey}:skipped`, { trigger: f.trigger });
    if (id) this.r.automations.finishRun(id, 'skipped', reason);
    return false;
  }

  private needTask(f: FireContext, what: string): Task {
    if (!f.task) throw new ValidationError(`“${what}” needs a task, but this trigger is about a project`);
    const t = this.r.tasks.get(f.task.id);
    if (!t || t.deletedAt) throw new NotFoundError('The task');
    return t;
  }

  private apply(action: AutomationAction, f: FireContext, a: Automation, pending: { label: string; run: () => Promise<unknown> }[]): string {
    const today = this.today();
    const vars = {
      taskTitle: f.task?.title,
      projectName: f.project?.name ?? (f.task?.projectId ? this.r.projects.get(f.task.projectId)?.name : undefined),
      date: today,
    };
    const force = { force: true }; // automations are deliberate; don't stop for "are you sure?" checks
    switch (action.type) {
      case 'createTask': {
        const projectId = action.sameProject ? (f.task?.projectId ?? f.project?.id ?? null) : action.projectId;
        const t = this.svc.tasks.create({
          title: renderTemplate(action.title, vars) || 'Follow up',
          projectId,
          priority: action.priority as Priority,
          scheduledDate: action.scheduleInDays === null ? null : addDays(today, action.scheduleInDays),
        });
        return `Created task “${t.title}”`;
      }
      case 'createSubtask': {
        const parent = this.needTask(f, 'Create subtask');
        const t = this.svc.tasks.create({ title: renderTemplate(action.title, vars) || 'Subtask', parentId: parent.id });
        return `Added subtask “${t.title}”`;
      }
      case 'setPriority':
        this.svc.tasks.update(this.needTask(f, 'Set priority').id, { priority: action.priority as Priority }, force);
        return `Set priority to P${action.priority}`;
      case 'addLabel': {
        const t = this.needTask(f, 'Add label');
        const l = this.r.labels.get(action.labelId);
        if (!l || l.deletedAt) throw new ValidationError('The label in this automation no longer exists');
        if (!t.labelIds.includes(l.id)) this.svc.tasks.update(t.id, { labelIds: [...t.labelIds, l.id] }, force);
        return `Added label @${l.name}`;
      }
      case 'removeLabel': {
        const t = this.needTask(f, 'Remove label');
        this.svc.tasks.update(t.id, { labelIds: t.labelIds.filter((x) => x !== action.labelId) }, force);
        return 'Removed label';
      }
      case 'moveToProject': {
        const t = this.needTask(f, 'Move');
        this.svc.tasks.update(t.id, { projectId: action.projectId, sectionId: null, parentId: null }, force);
        return `Moved to ${action.projectId ? (this.r.projects.get(action.projectId)?.name ?? 'project') : 'Inbox'}`;
      }
      case 'setStatus': {
        const t = this.needTask(f, 'Set status');
        if (action.status === 'completed') {
          if (isOpenStatus(t.status)) this.svc.tasks.complete(t.id, force);
        } else this.svc.tasks.setStatus(t.id, action.status);
        return `Set status to ${STATUS_LABELS[action.status]}`;
      }
      case 'scheduleInDays':
        this.svc.tasks.update(this.needTask(f, 'Schedule').id, { scheduledDate: addDays(today, action.days) }, force);
        return action.days === 0 ? 'Scheduled for today' : `Scheduled in ${action.days} day(s)`;
      case 'createReminder':
        this.svc.content.addReminder(this.needTask(f, 'Create reminder').id, { kind: 'relative', offsetMinutes: action.minutesBefore });
        return `Added a reminder ${action.minutesBefore} min before`;
      case 'notify': {
        const body = renderTemplate(action.message, vars);
        pending.push({ label: 'Notification', run: async () => this.notifier(a.name, body) });
        return `Notify: ${body}`;
      }
      case 'webhook': {
        const w = this.r.integrations.getWebhook(action.webhookId);
        if (!w) throw new ValidationError('The webhook in this automation no longer exists');
        const payload = this.svc.webhooks.buildPayload(f.trigger, { task: f.task, project: f.project });
        pending.push({ label: `Webhook “${w.name}”`, run: () => this.svc.webhooks.send(w.id, payload) });
        return `Called webhook “${w.name}”`;
      }
      case 'archiveTask':
        this.svc.tasks.setStatus(this.needTask(f, 'Archive task').id, 'archived');
        return 'Archived the task';
      case 'archiveProject': {
        const pid = f.project?.id ?? f.task?.projectId;
        if (!pid) throw new ValidationError('There is no project to archive');
        this.svc.projects.archive(pid);
        return 'Archived the project';
      }
      case 'applyTemplate': {
        const pid = f.project?.id ?? f.task?.projectId;
        if (!pid) throw new ValidationError('There is no project to apply the template to');
        this.svc.templates.applyToProject(action.templateId, pid, today);
        return 'Added tasks from a template';
      }
    }
  }

  // --- Test mode -----------------------------------------------------------------

  describeAction(action: AutomationAction): string {
    switch (action.type) {
      case 'createTask': return `Create task “${action.title}”${action.scheduleInDays !== null ? ` scheduled in ${action.scheduleInDays} day(s)` : ''}`;
      case 'createSubtask': return `Add subtask “${action.title}”`;
      case 'setPriority': return `Set priority to P${action.priority}`;
      case 'addLabel': return `Add label @${this.r.labels.get(action.labelId)?.name ?? '(deleted label)'}`;
      case 'removeLabel': return `Remove label @${this.r.labels.get(action.labelId)?.name ?? '(deleted label)'}`;
      case 'moveToProject': return `Move to ${action.projectId ? (this.r.projects.get(action.projectId)?.name ?? '(deleted project)') : 'Inbox'}`;
      case 'setStatus': return `Set status to ${STATUS_LABELS[action.status]}`;
      case 'scheduleInDays': return action.days === 0 ? 'Schedule for today' : `Schedule ${action.days} day(s) from today`;
      case 'createReminder': return `Add a reminder ${action.minutesBefore} minutes before`;
      case 'notify': return `Notify: “${action.message}”`;
      case 'webhook': return `Call webhook “${this.r.integrations.getWebhook(action.webhookId)?.name ?? '(deleted webhook)'}”`;
      case 'archiveTask': return 'Archive the task';
      case 'archiveProject': return 'Archive the project';
      case 'applyTemplate': return `Add tasks from template “${this.svc.templates.list().find((t) => t.id === action.templateId)?.name ?? '(deleted template)'}”`;
    }
  }

  /** Dry run against a chosen task or project: reports whether it would fire and what it would do. Changes nothing. */
  test(input: AutomationInput, target: { taskId?: string; projectId?: string }): TestResult {
    let def;
    try {
      def = automationInputSchema.parse(input);
    } catch (e) {
      toValidationError(e);
    }
    this.filterCtx = null;
    const a: Automation = { ...def, id: 'test', lastRunAt: null, createdAt: '' };
    const task = target.taskId ? this.r.tasks.get(target.taskId) : undefined;
    const project = target.projectId ? this.r.projects.get(target.projectId) : undefined;
    const m = this.matches(a, { trigger: def.trigger.type, task, project, eventKey: 'test' }, { labelId: def.trigger.labelId });
    return { matches: m.ok, reason: m.reason, actions: def.actions.map((x) => this.describeAction(x)) };
  }
}
