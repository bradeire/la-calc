import { filterDefinitionSchema, type FilterDefinition } from '@/core/filters/types';
import type { DatabaseDriver, Row } from '../db/driver';
import { bool, newId, nowIso, num, str, track } from './base';

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
  let definition: FilterDefinition | null = null;
  try {
    const parsed = filterDefinitionSchema.safeParse(JSON.parse(str(r.definition_json)));
    definition = parsed.success ? (parsed.data as FilterDefinition) : null;
  } catch {
    definition = null;
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
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    if (f.name !== undefined) (cols.push('name = ?'), vals.push(f.name));
    if (f.query !== undefined) (cols.push('query = ?'), vals.push(f.query));
    if (f.definition !== undefined) (cols.push('definition_json = ?'), vals.push(JSON.stringify(f.definition)));
    if (f.color !== undefined) (cols.push('color = ?'), vals.push(f.color));
    if (f.isFavorite !== undefined) (cols.push('is_favorite = ?'), vals.push(f.isFavorite ? 1 : 0));
    if (f.deletedAt !== undefined) (cols.push('deleted_at = ?'), vals.push(f.deletedAt));
    if (!cols.length) return;
    this.db.run(`UPDATE saved_filters SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, nowIso(), id]);
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
