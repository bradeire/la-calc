import type { Project, ProjectLayout, Section } from '@/core/domain/types';
import type { DatabaseDriver, Row, SqlValue } from '../db/driver';
import { bool, newId, nowIso, num, setClause, str, strOrNull, track } from './base';

export function mapProject(r: Row): Project {
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    notes: str(r.notes),
    color: str(r.color),
    icon: str(r.icon),
    parentId: strOrNull(r.parent_id),
    layout: str(r.layout) as ProjectLayout,
    isFavorite: bool(r.is_favorite),
    archivedAt: strOrNull(r.archived_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    deletedAt: strOrNull(r.deleted_at),
    sortOrder: num(r.sort_order),
    collapsed: bool(r.collapsed),
    isSample: bool(r.is_sample),
  };
}

export function mapSection(r: Row): Section {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    name: str(r.name),
    sortOrder: num(r.sort_order),
    collapsed: bool(r.collapsed),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    deletedAt: strOrNull(r.deleted_at),
  };
}

const PROJECT_COLS: Partial<Record<keyof Project, string>> = {
  name: 'name',
  description: 'description',
  notes: 'notes',
  color: 'color',
  icon: 'icon',
  parentId: 'parent_id',
  layout: 'layout',
  isFavorite: 'is_favorite',
  archivedAt: 'archived_at',
  deletedAt: 'deleted_at',
  sortOrder: 'sort_order',
  collapsed: 'collapsed',
  isSample: 'is_sample',
};

const v = (x: unknown): SqlValue => (typeof x === 'boolean' ? (x ? 1 : 0) : ((x ?? null) as SqlValue));

export interface ProjectStats {
  open: number;
  completed: number;
}

export class ProjectRepository {
  constructor(private db: DatabaseDriver) {}

  insert(p: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'archivedAt' | 'collapsed'> & { id?: string }): string {
    const id = p.id ?? newId();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO projects (id, name, description, notes, color, icon, parent_id, layout, is_favorite, created_at, updated_at, sort_order, is_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.name, p.description, p.notes, p.color, p.icon, p.parentId, p.layout, p.isFavorite ? 1 : 0, ts, ts, p.sortOrder, p.isSample ? 1 : 0],
    );
    track(this.db, 'projects', id, 'insert');
    return id;
  }

  update(id: string, patch: Partial<Project>): void {
    const cols: Record<string, SqlValue> = {};
    for (const [k, val] of Object.entries(patch)) {
      const c = PROJECT_COLS[k as keyof Project];
      if (c) cols[c] = v(val);
    }
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowIso();
    const { sql, values } = setClause(cols);
    this.db.run(`UPDATE projects SET ${sql} WHERE id = ?`, [...values, id]);
    track(this.db, 'projects', id, 'update');
  }

  get(id: string): Project | undefined {
    const r = this.db.get('SELECT * FROM projects WHERE id = ?', [id]);
    return r ? mapProject(r) : undefined;
  }

  /** Non-deleted projects, optionally including archived ones. */
  list(opts: { includeArchived?: boolean } = {}): Project[] {
    const arch = opts.includeArchived ? '' : 'AND archived_at IS NULL';
    return this.db.all(`SELECT * FROM projects WHERE deleted_at IS NULL ${arch} ORDER BY sort_order, name`).map(mapProject);
  }

  listArchived(): Project[] {
    return this.db.all('SELECT * FROM projects WHERE deleted_at IS NULL AND archived_at IS NOT NULL ORDER BY name').map(mapProject);
  }

  listTrash(): Project[] {
    return this.db
      .all(
        `SELECT * FROM projects p WHERE deleted_at IS NOT NULL
         AND (parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects q WHERE q.id = p.parent_id AND q.deleted_at = p.deleted_at))
         ORDER BY deleted_at DESC`,
      )
      .map(mapProject);
  }

  descendantIds(id: string): string[] {
    return this.db
      .all<{ id: string }>(
        `WITH RECURSIVE d(id) AS (SELECT id FROM projects WHERE parent_id = ? UNION ALL SELECT p.id FROM projects p JOIN d ON p.parent_id = d.id)
         SELECT id FROM d`,
        [id],
      )
      .map((r) => r.id);
  }

  nextSortOrder(parentId: string | null): number {
    return num(this.db.get<{ m: number }>('SELECT MAX(sort_order) AS m FROM projects WHERE parent_id IS ?', [parentId])?.m) + 1;
  }

  /** Open/completed task counts per project (all depths, excluding deleted). */
  stats(): Map<string, ProjectStats> {
    const rows = this.db.all<{ project_id: string; open: number; completed: number }>(
      `SELECT project_id, SUM(status IN ('inbox','active','in_progress','waiting')) AS open, SUM(status = 'completed') AS completed
       FROM tasks WHERE deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id`,
    );
    return new Map(rows.map((r) => [r.project_id, { open: Number(r.open), completed: Number(r.completed) }]));
  }

  hardDelete(id: string): void {
    this.db.run('DELETE FROM projects WHERE id = ?', [id]);
    track(this.db, 'projects', id, 'delete');
  }

  // --- Sections ------------------------------------------------------------

  insertSection(projectId: string, name: string, sortOrder?: number): string {
    const id = newId();
    const ts = nowIso();
    const order = sortOrder ?? num(this.db.get<{ m: number }>('SELECT MAX(sort_order) AS m FROM sections WHERE project_id = ?', [projectId])?.m) + 1;
    this.db.run('INSERT INTO sections (id, project_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      projectId,
      name,
      order,
      ts,
      ts,
    ]);
    track(this.db, 'sections', id, 'insert');
    return id;
  }

  updateSection(id: string, patch: Partial<Pick<Section, 'name' | 'sortOrder' | 'collapsed' | 'deletedAt'>>): void {
    const cols: Record<string, SqlValue> = {};
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.sortOrder !== undefined) cols.sort_order = patch.sortOrder;
    if (patch.collapsed !== undefined) cols.collapsed = patch.collapsed ? 1 : 0;
    if (patch.deletedAt !== undefined) cols.deleted_at = patch.deletedAt;
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowIso();
    const { sql, values } = setClause(cols);
    this.db.run(`UPDATE sections SET ${sql} WHERE id = ?`, [...values, id]);
    track(this.db, 'sections', id, 'update');
  }

  getSection(id: string): Section | undefined {
    const r = this.db.get('SELECT * FROM sections WHERE id = ?', [id]);
    return r ? mapSection(r) : undefined;
  }

  listSections(projectId: string): Section[] {
    return this.db.all('SELECT * FROM sections WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order', [projectId]).map(mapSection);
  }
}
