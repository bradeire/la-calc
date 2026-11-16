import { z } from 'zod';
import type { DatabaseDriver, Row } from '../db/driver';
import { bool, newId, nowIso, str, track } from './base';

export const webhookConfigSchema = z.object({
  url: z.string().url('Enter a full URL, e.g. http://homeassistant.local:8123/api/webhook/focus-task'),
  /** Whether a signing secret is stored (the secret itself lives in the SecretStore). */
  signed: z.boolean().default(false),
});
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export interface Webhook {
  id: string;
  name: string;
  url: string;
  signed: boolean;
  enabled: boolean;
}

function map(r: Row): Webhook {
  const cfg = webhookConfigSchema.safeParse(JSON.parse(str(r.config_json) || '{}'));
  return { id: str(r.id), name: str(r.name), url: cfg.success ? cfg.data.url : '', signed: cfg.success ? cfg.data.signed : false, enabled: bool(r.enabled) };
}

export class IntegrationRepository {
  constructor(private db: DatabaseDriver) {}
  insertWebhook(name: string, cfg: WebhookConfig, enabled = true): string {
    const id = newId();
    const ts = nowIso();
    this.db.run("INSERT INTO integrations (id, kind, name, config_json, enabled, created_at, updated_at) VALUES (?, 'webhook', ?, ?, ?, ?, ?)", [id, name, JSON.stringify(cfg), enabled ? 1 : 0, ts, ts]);
    track(this.db, 'integrations', id, 'insert');
    return id;
  }
  updateWebhook(id: string, name: string, cfg: WebhookConfig, enabled: boolean) {
    this.db.run('UPDATE integrations SET name = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?', [name, JSON.stringify(cfg), enabled ? 1 : 0, nowIso(), id]);
    track(this.db, 'integrations', id, 'update');
  }
  softDelete(id: string, at: string | null = nowIso()) {
    this.db.run('UPDATE integrations SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, nowIso(), id]);
    track(this.db, 'integrations', id, 'update');
  }
  listWebhooks(): Webhook[] {
    return this.db.all("SELECT * FROM integrations WHERE kind = 'webhook' AND deleted_at IS NULL ORDER BY name").map(map);
  }
  getWebhook(id: string): Webhook | undefined {
    return this.listWebhooks().find((w) => w.id === id);
  }
}
