import { automationInputSchema, type Automation, type AutomationDef, type AutomationRun } from '@/core/automation/types';
import type { DatabaseDriver, Row } from '../db/driver';
import { bool, newId, nowIso, num, str, strOrNull, track } from './base';

function mapAutomation(r: Row): Automation | null {
  const parsed = automationInputSchema.safeParse({
    name: str(r.name),
    enabled: bool(r.enabled),
    trigger: JSON.parse(str(r.trigger_json)),
    conditions: JSON.parse(str(r.conditions_json) || 'null'),
    actions: JSON.parse(str(r.actions_json)),
    maxRunsPerHour: num(r.max_runs_per_hour),
  });
  if (!parsed.success) {
    console.error(`Automation ${str(r.id)} has an invalid definition and is ignored`, parsed.error);
    return null;
  }
  return { ...parsed.data, id: str(r.id), lastRunAt: strOrNull(r.last_run_at), createdAt: str(r.created_at) };
}

const mapRun = (r: Row): AutomationRun => ({
  id: str(r.id),
  automationId: str(r.automation_id),
  eventKey: str(r.event_key),
  status: str(r.status) as AutomationRun['status'],
  startedAt: str(r.started_at),
  finishedAt: strOrNull(r.finished_at),
  error: strOrNull(r.error),
  details: JSON.parse(str(r.details_json) || '{}') as Record<string, unknown>,
});

export class AutomationRepository {
  constructor(private db: DatabaseDriver) {}

  insert(a: AutomationDef): string {
    const id = newId();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO automations (id, name, enabled, trigger_json, conditions_json, actions_json, max_runs_per_hour, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.maxRunsPerHour, ts, ts],
    );
    track(this.db, 'automations', id, 'insert');
    return id;
  }

  update(id: string, a: AutomationDef): void {
    this.db.run(
      `UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, conditions_json = ?, actions_json = ?, max_runs_per_hour = ?, updated_at = ? WHERE id = ?`,
      [a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.maxRunsPerHour, nowIso(), id],
    );
    track(this.db, 'automations', id, 'update');
  }

  setEnabled(id: string, enabled: boolean) {
    this.db.run('UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, nowIso(), id]);
    track(this.db, 'automations', id, 'update');
  }

  softDelete(id: string, at: string | null = nowIso()) {
    this.db.run('UPDATE automations SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, nowIso(), id]);
    track(this.db, 'automations', id, 'update');
  }

  list(): Automation[] {
    return this.db
      .all('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at')
      .map(mapAutomation)
      .filter((a): a is Automation => !!a);
  }

  get(id: string): Automation | undefined {
    const r = this.db.get('SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL', [id]);
    return r ? (mapAutomation(r) ?? undefined) : undefined;
  }

  /** Records a run; returns null if this automation already ran for this event (duplicate prevention). */
  startRun(automationId: string, eventKey: string, details: Record<string, unknown> = {}): string | null {
    const id = newId();
    this.db.run(
      `INSERT OR IGNORE INTO automation_runs (id, automation_id, event_key, status, started_at, details_json) VALUES (?, ?, ?, 'running', ?, ?)`,
      [id, automationId, eventKey, nowIso(), JSON.stringify(details)],
    );
    return this.db.get('SELECT 1 FROM automation_runs WHERE id = ?', [id]) ? id : null;
  }

  finishRun(id: string, status: AutomationRun['status'], error: string | null, details?: Record<string, unknown>) {
    const ts = nowIso();
    if (details) {
      this.db.run('UPDATE automation_runs SET status = ?, error = ?, finished_at = ?, details_json = ? WHERE id = ?', [status, error, ts, JSON.stringify(details), id]);
    } else {
      this.db.run('UPDATE automation_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', [status, error, ts, id]);
    }
    this.db.run('UPDATE automations SET last_run_at = ? WHERE id = (SELECT automation_id FROM automation_runs WHERE id = ?)', [ts, id]);
  }

  runsSince(automationId: string, sinceIso: string): number {
    return num(
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND started_at >= ? AND status != 'skipped'", [automationId, sinceIso])?.n,
    );
  }

  listRuns(automationId?: string, limit = 100): AutomationRun[] {
    const where = automationId ? 'WHERE automation_id = ?' : '';
    return this.db.all(`SELECT * FROM automation_runs ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`, automationId ? [automationId, limit] : [limit]).map(mapRun);
  }
}
