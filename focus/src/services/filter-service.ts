import { todayISO } from '@/core/dates';
import { applyFilter, type FilterContext } from '@/core/filters/evaluate';
import { parseQuery, toQuery } from '@/core/filters/query';
import type { Condition, FilterDefinition } from '@/core/filters/types';
import { PALETTE, type Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import type { SavedFilter } from '@/data/repositories/filters';
import { NotFoundError, ValidationError, type UndoAction } from './events';

export class FilterService {
  constructor(private r: Repositories, private now: () => Date = () => new Date()) {}

  lookups() {
    return {
      projects: this.r.projects.list({ includeArchived: true }).map((p) => ({ id: p.id, name: p.name })),
      labels: this.r.labels.list().map((l) => ({ id: l.id, name: l.name })),
    };
  }

  parse(query: string) {
    return parseQuery(query, this.lookups());
  }

  toQuery(root: Condition) {
    return toQuery(root, this.lookups());
  }

  context(): FilterContext {
    const projects = this.r.projects.list({ includeArchived: true });
    const tree = new Map<string, Set<string>>();
    for (const p of projects) tree.set(p.id, new Set([p.id, ...this.r.projects.descendantIds(p.id)]));
    const edges = this.r.dependencies.all();
    const open = new Set(
      this.r.db.all<{ id: string }>("SELECT id FROM tasks WHERE deleted_at IS NULL AND status IN ('inbox','active','in_progress','waiting')").map((x) => x.id),
    );
    return {
      today: todayISO(this.now()),
      weekStartsOn: this.r.settings.getAll().weekStartsOn,
      projectTree: tree,
      blocked: this.r.dependencies.blockedIds(),
      blocking: new Set(edges.filter((e) => open.has(e.taskId) && open.has(e.dependsOnId)).map((e) => e.dependsOnId)),
    };
  }

  /** Run a filter over all tasks outside archived or deleted projects. */
  run(root: Condition): Task[] {
    return applyFilter(root, this.r.tasks.listForFilters(), this.context());
  }

  list(): SavedFilter[] {
    return this.r.filters.list();
  }

  save(input: { id?: string; name: string; definition: FilterDefinition; color?: string; isFavorite?: boolean }): string {
    const name = input.name.trim();
    if (!name) throw new ValidationError('A filter needs a name');
    if (name.length > 80) throw new ValidationError('Filter names are limited to 80 characters');
    const query = this.toQuery(input.definition.root);
    if (input.id) {
      if (!this.r.filters.get(input.id)) throw new NotFoundError('That filter');
      this.r.filters.update(input.id, { name, query, definition: input.definition, color: input.color, isFavorite: input.isFavorite });
      return input.id;
    }
    return this.r.filters.insert({
      name,
      query,
      definition: input.definition,
      color: input.color ?? PALETTE[(this.list().length + 5) % PALETTE.length]!.value,
      isFavorite: input.isFavorite ?? false,
    });
  }

  setFavorite(id: string, fav: boolean) {
    this.r.filters.update(id, { isFavorite: fav });
  }

  remove(id: string): UndoAction {
    const f = this.r.filters.get(id);
    if (!f) throw new NotFoundError('That filter');
    this.r.filters.update(id, { deletedAt: new Date().toISOString() });
    return { label: `Deleted filter “${f.name}”`, undo: () => this.r.filters.update(id, { deletedAt: null }) };
  }
}
