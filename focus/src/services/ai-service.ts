import { z } from 'zod';
import { todayISO } from '@/core/dates';
import { isOpenStatus, type Priority } from '@/core/domain/types';
import { parseQuery } from '@/core/filters/query';
import { templateSchema, type TemplateBody } from '@/core/templates';
import type { Repositories } from '@/data';
import type { HttpAdapter, SecretStore } from '@/platform/types';
import { NotFoundError, ValidationError } from './events';

/**
 * Optional AI assistance (spec 5.3). Off by default; works only after the user
 * configures a provider AND consents to sending data to that exact address.
 * Every feature returns suggestions — nothing here changes tasks.
 */
export const aiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ollama', 'openai']).default('ollama'),
  baseUrl: z.string().default('http://localhost:11434'),
  model: z.string().default('llama3.1'),
  /** Include task descriptions in requests (titles, dates and priorities are always included). */
  sendDescriptions: z.boolean().default(false),
  /** Consent is tied to the URL it was given for; changing the URL withdraws it. */
  consentUrl: z.string().nullable().default(null),
  consentAt: z.string().nullable().default(null),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const KEY = 'ai:apikey';
const SYSTEM = 'You are a careful assistant inside a personal task manager. Reply with JSON only, matching the requested shape exactly. Use British English. Do not invent facts about the user.';

/** True for addresses that stay on this machine or local network. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local') || h.endsWith('.lan') ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

/** Models sometimes wrap JSON in prose or code fences; take the first JSON object. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ValidationError('The AI reply was not in the expected format');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ValidationError('The AI reply was not valid JSON');
  }
}

const subtasksSchema = z.object({ subtasks: z.array(z.object({ title: z.string().min(1).max(200), minutes: z.number().int().positive().max(1440).nullish() })).max(20) });
const suggestSchema = z.object({
  priority: z.number().int().min(1).max(4).nullish(),
  project: z.string().max(120).nullish(),
  labels: z.array(z.string().max(60)).max(5).nullish(),
  description: z.string().max(2000).nullish(),
  minutes: z.number().int().positive().max(1440).nullish(),
});
const summarySchema = z.object({ summary: z.string().min(1).max(3000), risks: z.array(z.string().max(300)).max(10).nullish() });
const querySchema = z.object({ query: z.string().min(1).max(300) });
const extractSchema = z.object({ tasks: z.array(z.object({ title: z.string().min(1).max(200), due: z.string().max(40).nullish() })).max(30) });
const reviewSchema = z.object({ advice: z.array(z.object({ task: z.number().int().nullish(), text: z.string().max(400) })).max(15) });

export interface AiSuggestion {
  priority?: Priority;
  projectId?: string;
  projectName?: string;
  labelIds?: string[];
  labelNames?: string[];
  description?: string;
  durationMinutes?: number;
}

export class AiService {
  constructor(private r: Repositories, private http: HttpAdapter, private secrets: SecretStore) {}

  config(): AiConfig {
    const raw = this.r.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'ai'");
    const parsed = aiConfigSchema.safeParse(raw ? JSON.parse(raw.value_json) : {});
    return parsed.success ? parsed.data : aiConfigSchema.parse({});
  }

  async saveConfig(patch: Partial<AiConfig>, apiKey?: string | null): Promise<AiConfig> {
    const next = aiConfigSchema.parse({ ...this.config(), ...patch });
    try {
      new URL(next.baseUrl);
    } catch {
      throw new ValidationError('Enter a full server address, e.g. http://localhost:11434');
    }
    if (next.consentUrl && next.consentUrl !== next.baseUrl) {
      next.consentUrl = null; // a new destination needs fresh consent
      next.consentAt = null;
    }
    this.r.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('ai', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [JSON.stringify(next), new Date().toISOString()],
    );
    if (apiKey !== undefined) {
      if (apiKey) await this.secrets.set(KEY, apiKey);
      else await this.secrets.delete(KEY);
    }
    return next;
  }

  async giveConsent(): Promise<AiConfig> {
    const c = this.config();
    return this.saveConfig({ consentUrl: c.baseUrl, consentAt: new Date().toISOString() });
  }

  /** Why AI cannot be used right now, or null if it can. */
  unavailableReason(): string | null {
    const c = this.config();
    if (!c.enabled) return 'AI assistance is turned off (Settings → AI assistant).';
    if (!c.model.trim()) return 'Choose a model in Settings → AI assistant.';
    if (c.consentUrl !== c.baseUrl) return `You have not agreed to send task data to ${c.baseUrl} yet.`;
    return null;
  }

  // --- Prompt builders (also used to show "what will be sent") -----------------------

  private taskLine(id: string, includeDescription = this.config().sendDescriptions): string {
    const t = this.r.tasks.get(id);
    if (!t) throw new NotFoundError('That task');
    const project = t.projectId ? this.r.projects.get(t.projectId)?.name : 'Inbox';
    const parts = [`Title: ${t.title}`, `Project: ${project}`, `Priority: P${t.priority}`];
    if (t.scheduledDate) parts.push(`Scheduled: ${t.scheduledDate}`);
    if (t.deadline) parts.push(`Deadline: ${t.deadline}`);
    if (includeDescription && t.description) parts.push(`Description: ${t.description.slice(0, 1500)}`);
    return parts.join('\n');
  }

  breakdownPrompt(taskId: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Break this task into 3–8 concrete subtasks in a sensible order.\n\n${this.taskLine(taskId)}\n\nReply as {"subtasks":[{"title":"...","minutes":30}]}` },
    ];
  }

  suggestPrompt(taskId: string): ChatMessage[] {
    const projects = this.r.projects.list().map((p) => p.name).slice(0, 60);
    const labels = this.r.labels.list().map((l) => l.name).slice(0, 60);
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Suggest a priority (1 = most urgent, 4 = least), the best project from this list, up to 3 labels from this list, a one-paragraph description, and an estimate in minutes.\n\nProjects: ${projects.join(', ') || '(none)'}\nLabels: ${labels.join(', ') || '(none)'}\n\n${this.taskLine(taskId)}\n\nReply as {"priority":2,"project":"...","labels":["..."],"description":"...","minutes":30}. Use null for anything you are unsure about.`,
      },
    ];
  }

  summaryPrompt(projectId: string): ChatMessage[] {
    const p = this.r.projects.get(projectId);
    if (!p) throw new NotFoundError('That project');
    const tasks = this.r.tasks.listByProject(projectId, { includeClosed: true }).slice(0, 150);
    const lines = tasks.map((t) => `- [${isOpenStatus(t.status) ? ' ' : 'x'}] ${t.title}${t.deadline ? ` (deadline ${t.deadline})` : ''}${t.scheduledDate ? ` (planned ${t.scheduledDate})` : ''}`);
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Today is ${todayISO()}. Summarise the state of the project "${p.name}" in 3–5 sentences and list any risks (late or at-risk items).\n\n${lines.join('\n')}\n\nReply as {"summary":"...","risks":["..."]}` },
    ];
  }

  filterPrompt(request: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Convert the request into a Focus filter query. Syntax: p1–p4; #Project; @label; @none; status:waiting (statuses: inbox, active, in_progress, waiting, completed); scheduled:/deadline:/due:/start:/completed: with today, tomorrow, overdue, none, any, this-week, next-week, this-month, next-7-days, or YYYY-MM-DD, also < > <= >= with +7d or a date; duration<15; blocked; blocking; recurring; subtask; overdue; operators & | ! and parentheses.\nProjects: ${this.r.projects.list().map((p) => p.name).join(', ') || '(none)'}\nLabels: ${this.r.labels.list().map((l) => l.name).join(', ') || '(none)'}\n\nRequest: ${request}\n\nReply as {"query":"..."}`,
      },
    ];
  }

  extractPrompt(text: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Today is ${todayISO()}. List the action items for me in this text. Skip anything already done.\n\n"""\n${text.slice(0, 12000)}\n"""\n\nReply as {"tasks":[{"title":"...","due":"friday"}]} with "due" in plain words or null.` },
    ];
  }

  templatePrompt(description: string): ChatMessage[] {
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Create a project template for: ${description}\nUse 2–4 sections and 5–15 tasks. Dates are day offsets from the project start (0 = start day).\nReply as {"v":1,"project":{"color":"#0d9488","icon":"folder","layout":"list","description":"..."},"sections":["..."],"tasks":[{"ref":"a","title":"...","section":"...","priority":4,"scheduledOffset":0,"deadlineOffset":null,"durationMinutes":30,"dependsOn":[]}]}`,
      },
    ];
  }

  reviewPrompt(): ChatMessage[] {
    const open = this.r.tasks.listForFilters().filter((t) => isOpenStatus(t.status) && (t.scheduledDate || t.deadline)).slice(0, 80);
    const lines = open.map((t, i) => `${i}. ${t.title} | P${t.priority} | planned ${t.scheduledDate ?? '-'} | deadline ${t.deadline ?? '-'} | estimate ${t.durationMinutes ?? '?'} min`);
    const s = this.r.settings.getAll();
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Today is ${todayISO()}. Working hours ${s.workingHours.start}–${s.workingHours.end}. Review this plan: point out work likely to become overdue and suggest a more realistic schedule. Refer to tasks by number.\n\n${lines.join('\n')}\n\nReply as {"advice":[{"task":0,"text":"..."}]}`,
      },
    ];
  }

  // --- Transport -------------------------------------------------------------------

  async chat(messages: ChatMessage[]): Promise<unknown> {
    const reason = this.unavailableReason();
    if (reason) throw new ValidationError(reason);
    const c = this.config();
    const base = c.baseUrl.replace(/\/+$/, '');
    let body: string;
    let url: string;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.provider === 'ollama') {
      url = `${base}/api/chat`;
      body = JSON.stringify({ model: c.model, messages, stream: false, format: 'json', options: { temperature: 0.2 } });
    } else {
      url = `${base}/chat/completions`;
      const key = await this.secrets.get(KEY);
      if (key) headers.Authorization = `Bearer ${key}`;
      else if (!isLocalUrl(base)) throw new ValidationError(this.secrets.persistent ? 'Add an API key in Settings → AI assistant' : 'Re-enter the API key (in the browser it is kept for this session only)');
      body = JSON.stringify({ model: c.model, messages, temperature: 0.2, response_format: { type: 'json_object' } });
    }
    let res;
    try {
      res = await this.http.request({ method: 'POST', url, headers, body, timeoutMs: 90000 });
    } catch (err) {
      throw new ValidationError(`Could not reach ${base}: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new ValidationError('The AI provider rejected the API key');
    if (res.status === 404) throw new ValidationError(`Model “${c.model}” or endpoint not found at ${base}`);
    if (res.status < 200 || res.status >= 300) throw new ValidationError(`The AI provider answered ${res.status}`);
    let data: unknown;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw new ValidationError('The AI provider sent an unreadable reply');
    }
    const content =
      c.provider === 'ollama'
        ? (data as { message?: { content?: string } }).message?.content
        : (data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ValidationError('The AI reply was empty');
    return extractJson(content);
  }

  private check<T>(schema: z.ZodType<T>, value: unknown): T {
    const r = schema.safeParse(value);
    if (!r.success) throw new ValidationError('The AI reply did not have the expected shape — try again or use a different model');
    return r.data;
  }

  // --- Features (all return suggestions) ----------------------------------------------

  async breakdown(taskId: string): Promise<{ title: string; minutes: number | null }[]> {
    const r = this.check(subtasksSchema, await this.chat(this.breakdownPrompt(taskId)));
    return r.subtasks.map((s) => ({ title: s.title.trim(), minutes: s.minutes ?? null }));
  }

  async suggest(taskId: string): Promise<AiSuggestion> {
    const r = this.check(suggestSchema, await this.chat(this.suggestPrompt(taskId)));
    const out: AiSuggestion = {};
    if (r.priority) out.priority = r.priority as Priority;
    if (r.project) {
      const p = this.r.projects.list().find((x) => x.name.toLowerCase() === r.project!.toLowerCase());
      if (p) {
        out.projectId = p.id;
        out.projectName = p.name;
      }
    }
    if (r.labels?.length) {
      const known = this.r.labels.list();
      const hits = r.labels.map((n) => known.find((l) => l.name.toLowerCase() === n.toLowerCase().replace(/^@/, ''))).filter((l) => !!l);
      if (hits.length) {
        out.labelIds = hits.map((l) => l!.id);
        out.labelNames = hits.map((l) => l!.name);
      }
    }
    if (r.description) out.description = r.description.trim();
    if (r.minutes) out.durationMinutes = r.minutes;
    return out;
  }

  async summariseProject(projectId: string) {
    return this.check(summarySchema, await this.chat(this.summaryPrompt(projectId)));
  }

  /** Returns a query that has been validated by Focus's own parser. */
  async generateFilter(request: string): Promise<string> {
    const r = this.check(querySchema, await this.chat(this.filterPrompt(request)));
    const lk = { projects: this.r.projects.list().map((p) => ({ id: p.id, name: p.name })), labels: this.r.labels.list().map((l) => ({ id: l.id, name: l.name })) };
    const parsed = parseQuery(r.query, lk);
    if (!parsed.definition) throw new ValidationError(`The AI suggested “${r.query}”, which is not a valid filter: ${parsed.error}`);
    return r.query;
  }

  async extract(text: string): Promise<{ title: string; due: string | null }[]> {
    const r = this.check(extractSchema, await this.chat(this.extractPrompt(text)));
    return r.tasks.map((t) => ({ title: t.title.trim(), due: t.due ?? null }));
  }

  async generateTemplate(description: string): Promise<TemplateBody> {
    return this.check(templateSchema, await this.chat(this.templatePrompt(description)));
  }

  async review(): Promise<{ taskTitle: string | null; text: string }[]> {
    const open = this.r.tasks.listForFilters().filter((t) => isOpenStatus(t.status) && (t.scheduledDate || t.deadline)).slice(0, 80);
    const r = this.check(reviewSchema, await this.chat(this.reviewPrompt()));
    return r.advice.map((a) => ({ taskTitle: a.task != null ? (open[a.task]?.title ?? null) : null, text: a.text }));
  }
}
