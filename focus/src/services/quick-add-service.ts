import { PALETTE, type Task } from '@/core/domain/types';
import type { ParseResult } from '@/core/nlp/parser';
import type { Repositories } from '@/data';
import { ValidationError } from './events';
import type { LabelService } from './label-service';
import type { ProjectService } from './project-service';
import type { TaskService } from './task-service';

export interface QuickAddDefaults {
  projectId?: string | null;
  sectionId?: string | null;
  parentId?: string | null;
  scheduledDate?: string | null;
  /** Used only when the typed text gives no date/time (e.g. clicking a calendar slot). */
  scheduledTime?: string | null;
  labelIds?: string[];
  pinnedToday?: boolean;
}

export interface QuickAddOverrides {
  title?: string;
  description?: string;
}

/** Turns a parse result into a saved task, creating new projects/labels in the same transaction. */
export class QuickAddService {
  constructor(
    private r: Repositories,
    private tasks: TaskService,
    private projects: ProjectService,
    private labels: LabelService,
  ) {}

  commit(parsed: ParseResult, defaults: QuickAddDefaults = {}, overrides: QuickAddOverrides = {}): Task {
    const title = (overrides.title ?? parsed.title).trim();
    if (!title) throw new ValidationError('Type a task name — dates, #projects and @labels on their own are not a task');
    return this.r.db.transaction(() => {
      let projectId = defaults.projectId ?? null;
      let sectionId = defaults.sectionId ?? null;
      if (parsed.project) {
        sectionId = null;
        if (parsed.project.id) projectId = parsed.project.id;
        else {
          const color = PALETTE[(this.r.projects.list().length + 3) % PALETTE.length]!.value;
          projectId = this.projects.create({ name: parsed.project.name, color }).id;
        }
      }
      const labelIds = [
        ...new Set([
          ...(defaults.labelIds ?? []),
          ...parsed.labels.filter((l) => l.id).map((l) => l.id!),
          ...this.labels.ensure(parsed.labels.filter((l) => !l.id).map((l) => l.name)),
        ]),
      ];
      return this.tasks.create({
        title,
        description: overrides.description ?? '',
        projectId,
        sectionId,
        parentId: parsed.project ? null : (defaults.parentId ?? null),
        priority: parsed.priority ?? 4,
        startDate: parsed.startDate,
        scheduledDate: parsed.scheduledDate ?? defaults.scheduledDate ?? null,
        scheduledTime: parsed.scheduledTime,
        deadline: parsed.deadline,
        durationMinutes: parsed.durationMinutes,
        labelIds,
        recurrence: parsed.recurrence,
        recurrenceText: parsed.recurrenceText,
        pinnedToday: defaults.pinnedToday ?? false,
      });
    });
  }
}
