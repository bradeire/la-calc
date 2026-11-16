import type { DatabaseDriver } from '../db/driver';
import { nowIso, placeholders, track } from './base';

import type { DependencyEdge } from '@/core/domain/types';
export type { DependencyEdge };

/** "taskId cannot finish before dependsOnId" edges. Cycle checks live in the service. */
export class DependencyRepository {
  constructor(private db: DatabaseDriver) {}

  add(taskId: string, dependsOnId: string): void {
    this.db.run('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)', [taskId, dependsOnId, nowIso()]);
    track(this.db, 'task_dependencies', `${taskId}>${dependsOnId}`, 'insert');
  }

  remove(taskId: string, dependsOnId: string): void {
    this.db.run('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?', [taskId, dependsOnId]);
    track(this.db, 'task_dependencies', `${taskId}>${dependsOnId}`, 'delete');
  }

  /** Prerequisites of a task (non-deleted). */
  prerequisitesOf(taskId: string): string[] {
    return this.db
      .all<{ id: string }>(
        `SELECT d.depends_on_id AS id FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
         WHERE d.task_id = ? AND t.deleted_at IS NULL ORDER BY t.title`,
        [taskId],
      )
      .map((r) => r.id);
  }

  /** Tasks that depend on this one (non-deleted). */
  dependentsOf(taskId: string): string[] {
    return this.db
      .all<{ id: string }>(
        `SELECT d.task_id AS id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
         WHERE d.depends_on_id = ? AND t.deleted_at IS NULL ORDER BY t.title`,
        [taskId],
      )
      .map((r) => r.id);
  }

  /** True if `fromId` can reach `toId` by following prerequisite edges. */
  reaches(fromId: string, toId: string): boolean {
    return !!this.db.get(
      `WITH RECURSIVE r(id) AS (
         SELECT depends_on_id FROM task_dependencies WHERE task_id = ?
         UNION SELECT d.depends_on_id FROM task_dependencies d JOIN r ON d.task_id = r.id
       ) SELECT 1 FROM r WHERE id = ? LIMIT 1`,
      [fromId, toId],
    );
  }

  /** Ids (from the given set, or all) that have at least one open, non-deleted prerequisite. */
  blockedIds(among?: readonly string[]): Set<string> {
    const filter = among ? `AND d.task_id IN (${placeholders(among.length)})` : '';
    if (among && among.length === 0) return new Set();
    return new Set(
      this.db
        .all<{ id: string }>(
          `SELECT DISTINCT d.task_id AS id FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_id
           WHERE p.deleted_at IS NULL AND p.status IN ('inbox','active','in_progress','waiting') ${filter}`,
          (among ?? []) as string[],
        )
        .map((r) => r.id),
    );
  }

  all(): DependencyEdge[] {
    return this.db.all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies').map((r) => ({
      taskId: r.task_id,
      dependsOnId: r.depends_on_id,
    }));
  }
}
