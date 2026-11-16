import { filterDefinitionSchema, type FilterDefinition } from '@/core/filters/types';
import type { DatabaseDriver, Row, SqlValue } from '../db/driver';
import { bool, newId, nowIso, num, setClause, str, track } from './base';

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  definition: FilterDefinition | null;
  color: string;
  isFavorite: boolean;
  sortOrder: number;
}

function map(r: Row): SavedFilter {
  let definition: FilterDefinition | null;
  try {
    const parsed = filterDefinitionSchema.safeParse(JSON.parse(str(r.definition_json)));
    definition = parsed.success ? (parsed.data as FilterDefinition) : null;
  } catch {
    definition = null; // unreadable JSON: the filter shows as needing repair rather than crashing
  }
  return { id: str(r.id), name: str(r.name), query: str(r.query), definition, color: str(r.color), isFavorite: bool(r.is_favorite), sortOrder: num(r.sort_order) };
}

export class SavedFilterRepository {
  constructor(private db: DatabaseDriver) {}
  insert(f: { name: string; query: string; definition: FilterDefinition; color: string; isFavorite: boolean }): string {
    const id = newId();
    const ts = nowIso();
    const order = num(this.db.get<{ m: number }>('SELECT MAX(sort_order) AS m FROM saved_filters')?.m) + 1;
    this.db.run(
      'INSERT INTO saved_filters (id, name, query, definition_json, color, is_favorite, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, f.name, f.query, JSON.stringify(f.definition), f.color, f.isFavorite ? 1 : 0, order, ts, ts],
    );
    track(this.db, 'saved_filters', id, 'insert');
    return id;
  }
  update(id: string, f: Partial<{ name: string; query: string; definition: FilterDefinition; color: string; isFavorite: boolean; deletedAt: string | null }>) {
    const cols: Record<string, SqlValue> = {};
    if (f.name !== undefined) cols.name = f.name;
    if (f.query !== undefined) cols.query = f.query;
    if (f.definition !== undefined) cols.definition_json = JSON.stringify(f.definition);
    if (f.color !== undefined) cols.color = f.color;
    if (f.isFavorite !== undefined) cols.is_favorite = f.isFavorite ? 1 : 0;
    if (f.deletedAt !== undefined) cols.deleted_at = f.deletedAt;
    if (!Object.keys(cols).length) return;
    cols.updated_at = nowIso();
    const { sql, values } = setClause(cols);
    this.db.run(`UPDATE saved_filters SET ${sql} WHERE id = ?`, [...values, id]);
    track(this.db, 'saved_filters', id, 'update');
  }
  list(): SavedFilter[] {
    return this.db.all('SELECT * FROM saved_filters WHERE deleted_at IS NULL ORDER BY sort_order, name').map(map);
  }
  get(id: string): SavedFilter | undefined {
    const r = this.db.get('SELECT * FROM saved_filters WHERE id = ? AND deleted_at IS NULL', [id]);
    return r ? map(r) : undefined;
  }
}
