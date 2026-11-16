import type { Project, Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import { webhookConfigSchema, type Webhook } from '@/data/repositories/integrations';
import type { HttpAdapter, SecretStore } from '@/platform/types';
import { NotFoundError, ValidationError, type UndoAction } from './events';

export interface WebhookPayload {
  event: string;
  sentAt: string;
  task?: { id: string; title: string; priority: number; status: string; project: string | null; scheduledDate: string | null; deadline: string | null };
  project?: { id: string; name: string };
  message?: string;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const secretKey = (id: string) => `webhook:${id}`;

/**
 * Outgoing webhooks (spec 5.5): Home Assistant, Zapier, IFTTT or anything that accepts JSON.
 * Payloads contain only the fields below — never descriptions, comments or attachments.
 */
export class WebhookService {
  constructor(private r: Repositories, private http: HttpAdapter, private secrets: SecretStore) {}

  list(): Webhook[] {
    return this.r.integrations.listWebhooks();
  }

  async save(input: { id?: string; name: string; url: string; enabled?: boolean; secret?: string | null }): Promise<string> {
    const name = input.name.trim();
    if (!name) throw new ValidationError('A webhook needs a name');
    const parsed = webhookConfigSchema.safeParse({ url: input.url.trim(), signed: false });
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]!.message);
    if (!/^https?:\/\//i.test(parsed.data.url)) throw new ValidationError('Webhook URLs must start with http:// or https://');
    const existing = input.id ? this.r.integrations.getWebhook(input.id) : undefined;
    let signed = existing?.signed ?? false;
    const id = input.id ?? this.r.integrations.insertWebhook(name, parsed.data, input.enabled ?? true);
    if (input.secret !== undefined) {
      if (input.secret) await this.secrets.set(secretKey(id), input.secret);
      else await this.secrets.delete(secretKey(id));
      signed = !!input.secret;
    }
    this.r.integrations.updateWebhook(id, name, { url: parsed.data.url, signed }, input.enabled ?? existing?.enabled ?? true);
    return id;
  }

  remove(id: string): UndoAction {
    const w = this.r.integrations.getWebhook(id);
    if (!w) throw new NotFoundError('That webhook');
    this.r.integrations.softDelete(id);
    return { label: `Deleted webhook “${w.name}”`, undo: () => this.r.integrations.softDelete(id, null) };
  }

  buildPayload(event: string, ctx: { task?: Task; project?: Project; message?: string }): WebhookPayload {
    const projectName = ctx.task?.projectId ? (this.r.projects.get(ctx.task.projectId)?.name ?? null) : null;
    return {
      event,
      sentAt: new Date().toISOString(),
      ...(ctx.task && {
        task: {
          id: ctx.task.id, title: ctx.task.title, priority: ctx.task.priority, status: ctx.task.status, project: projectName,
          scheduledDate: ctx.task.scheduledDate, deadline: ctx.task.deadline,
        },
      }),
      ...(ctx.project && { project: { id: ctx.project.id, name: ctx.project.name } }),
      ...(ctx.message && { message: ctx.message }),
    };
  }

  /** POST the payload. Signed webhooks carry X-Focus-Signature: sha256=<hex HMAC of the body>. */
  async send(id: string, payload: WebhookPayload): Promise<{ status: number }> {
    const w = this.r.integrations.getWebhook(id);
    if (!w) throw new NotFoundError('That webhook');
    if (!w.enabled) throw new ValidationError(`Webhook “${w.name}” is turned off`);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Focus-Event': payload.event };
    if (w.signed) {
      const secret = await this.secrets.get(secretKey(id));
      if (!secret) {
        throw new ValidationError(
          this.secrets.persistent ? `The signing secret for “${w.name}” is missing — re-enter it in Settings` : `Re-enter the signing secret for “${w.name}” (browser secrets last for one session)`,
        );
      }
      headers['X-Focus-Signature'] = `sha256=${await hmacHex(secret, body)}`;
    }
    const res = await this.http.request({ method: 'POST', url: w.url, headers, body, timeoutMs: 15000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`Webhook “${w.name}” answered ${res.status}`);
    return { status: res.status };
  }

  async test(id: string) {
    return this.send(id, { event: 'test', sentAt: new Date().toISOString(), message: 'Test from Focus' });
  }
}
