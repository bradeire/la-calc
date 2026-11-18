import type { Label } from '@/core/domain/types';
import type { DatabaseDriver, Row, SqlValue } from '../db/driver';
import { bool, newId, nowIso, num, setClause, str, strOrNull, track } from './base';

export function mapLabel(r: Row): Label {
  return {
    id: str(r.id),
    name: str(r.name),
    color: str(r.color),
    isFavorite: bool(r.is_favorite),
    sortOrder: num(r.sort_order),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    deletedAt: strOrNull(r.deleted_at),
    isSample: bool(r.is_sample),
  };
}

export class LabelRepository {
  constructor(private db: DatabaseDriver) {}

  insert(l: { name: string; color: string; isFavorite?: boolean; isSample?: boolean; id?: string }): string {
    const id = l.id ?? newId();
    const ts = nowIso();
    const order = num(this.db.get<{ m: number }>('SELECT MAX(sort_order) AS m FROM labels')?.m) + 1;
    this.db.run(
      'INSERT INTO labels (id, name, color, is_favorite, sort_order, created_at, updated_at, is_sample) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, l.name, l.color, l.isFavorite ? 1 : 0, order, ts, ts, l.isSample ? 1 : 0],
    );
    track(this.db, 'labels', id, 'insert');
    return id;
  }

  update(id: string, patch: Partial<Pick<Label, 'name' | 'color' | 'isFavorite' | 'sortOrder' | 'deletedAt'>>): void {
    const cols: Record<string, SqlValue> = {};
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.color !== undefined) cols.color = patch.color;
    if (patch.isFavorite !== undefined) cols.is_favorite = patch.isFavorite ? 1 : 0;
    if (patch.sortOrder !== undefined) cols.sort_order = patch.sortOrder;
    if (patch.deletedAt !== undefined) cols.deleted_at = patch.deletedAt;
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowIso();
    const { sql, values } = setClause(cols);
    this.db.run(`UPDATE labels SET ${sql} WHERE id = ?`, [...values, id]);
    track(this.db, 'labels', id, 'update');
  }

  get(id: string): Label | undefined {
    const r = this.db.get('SELECT * FROM labels WHERE id = ?', [id]);
    return r ? mapLabel(r) : undefined;
  }

  findByName(name: string): Label | undefined {
    const r = this.db.get('SELECT * FROM labels WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE', [name]);
    return r ? mapLabel(r) : undefined;
  }

  list(): Label[] {
    return this.db.all('SELECT * FROM labels WHERE deleted_at IS NULL ORDER BY sort_order, name').map(mapLabel);
  }

  listTrash(): Label[] {
    return this.db.all('SELECT * FROM labels WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').map(mapLabel);
  }

  /** Open-task count per label. */
  counts(): Map<string, number> {
    const rows = this.db.all<{ label_id: string; n: number }>(
      `SELECT tl.label_id, COUNT(*) AS n FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
       WHERE t.deleted_at IS NULL AND t.status IN ('inbox','active','in_progress','waiting') GROUP BY tl.label_id`,
    );
    return new Map(rows.map((r) => [r.label_id, Number(r.n)]));
  }

  hardDelete(id: string): void {
    this.db.run('DELETE FROM labels WHERE id = ?', [id]);
    track(this.db, 'labels', id, 'delete');
  }
}
