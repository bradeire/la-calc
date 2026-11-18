import type { DatabaseDriver } from '../db/driver';
import { newId, nowIso, str, track } from './base';

export interface TemplateRow {
  id: string;
  name: string;
  description: string;
  json: string;
  createdAt: string;
}

export class TemplateRepository {
  constructor(private db: DatabaseDriver) {}
  insert(name: string, description: string, json: string): string {
    const id = newId();
    const ts = nowIso();
    this.db.run('INSERT INTO project_templates (id, name, description, template_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, description, json, ts, ts]);
    track(this.db, 'project_templates', id, 'insert');
    return id;
  }
  list(): TemplateRow[] {
    return this.db
      .all('SELECT * FROM project_templates WHERE deleted_at IS NULL ORDER BY name')
      .map((r) => ({ id: str(r.id), name: str(r.name), description: str(r.description), json: str(r.template_json), createdAt: str(r.created_at) }));
  }
  get(id: string): TemplateRow | undefined {
    return this.list().find((t) => t.id === id);
  }
  softDelete(id: string, at: string | null = nowIso()) {
    this.db.run('UPDATE project_templates SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, nowIso(), id]);
    track(this.db, 'project_templates', id, 'update');
  }
}
