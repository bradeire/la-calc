import { addDays, todayISO, type ISODate } from '@/core/dates';
import { isOpenStatus } from '@/core/domain/types';
import { buildIcs, busyMinutesByDay, IcsError, parseIcs } from '@/core/ics';
import type { Repositories } from '@/data';
import type { CalendarSource, StoredEvent } from '@/data/repositories/calendars';
import type { HttpAdapter, SecretStore } from '@/platform/types';
import { ValidationError } from './events';

const secretKey = (id: string) => `calendar:${id}`;
/** Occurrences are kept from two months back to a year ahead. */
const WINDOW_BACK = 60;
const WINDOW_AHEAD = 366;

/** Normalise and check a subscription address (webcal:// is https:// for our purposes). */
export function normaliseCalendarUrl(input: string): string {
  const raw = input.trim().replace(/^webcals?:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Enter the calendar’s full address, starting with https:// or webcal://');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ValidationError('Calendar addresses must start with https:// or webcal://');
  return url.toString();
}

/**
 * External calendars (spec 6.4): read-only, from a private .ics address or an .ics file.
 * Focus's own calendar keeps working without any of this. The address is a secret (anyone
 * with it can read the calendar), so it is kept in the platform SecretStore, not SQLite.
 */
export class CalendarService {
  constructor(
    private r: Repositories,
    private http: HttpAdapter,
    private secrets: SecretStore,
    private now: () => Date = () => new Date(),
  ) {}

  sources(): CalendarSource[] {
    return this.r.calendars.list();
  }

  private window() {
    const today = todayISO(this.now());
    const [y, m, d] = addDays(today, -WINDOW_BACK).split('-').map(Number) as [number, number, number];
    const [y2, m2, d2] = addDays(today, WINDOW_AHEAD).split('-').map(Number) as [number, number, number];
    return { from: new Date(y, m - 1, d), to: new Date(y2, m2 - 1, d2) };
  }

  private store(id: string, text: string): number {
    const events = parseIcs(text, this.window());
    this.r.db.transaction(() => {
      this.r.calendars.replaceEvents(id, events);
      this.r.calendars.setSyncResult(id, null);
    });
    return events.length;
  }

  async addUrl(input: { name: string; url: string; color: string }): Promise<string> {
    const name = input.name.trim() || 'Calendar';
    const url = normaliseCalendarUrl(input.url);
    const text = await this.fetch(url);
    // Parse before saving anything, so a wrong address leaves nothing behind.
    parseIcs(text, this.window());
    const id = this.r.calendars.insert({ name, color: input.color, kind: 'url' });
    await this.secrets.set(secretKey(id), url);
    this.store(id, text);
    return id;
  }

  addFile(input: { name: string; text: string; color: string }): string {
    parseIcs(input.text, this.window());
    const id = this.r.calendars.insert({ name: input.name.trim() || 'Imported calendar', color: input.color, kind: 'file' });
    this.store(id, input.text);
    return id;
  }

  /** Whether the address is available (browser: only for this session). */
  async hasAddress(id: string): Promise<boolean> {
    return (await this.secrets.get(secretKey(id))) !== null;
  }

  async setAddress(id: string, url: string): Promise<void> {
    const u = normaliseCalendarUrl(url);
    await this.secrets.set(secretKey(id), u);
    await this.refresh(id);
  }

  private async fetch(url: string): Promise<string> {
    let res;
    try {
      res = await this.http.request({ method: 'GET', url, timeoutMs: 30_000 });
    } catch (err) {
      throw new ValidationError(`Couldn’t reach the calendar: ${err instanceof Error ? err.message : 'network error'}. In the browser version, calendar servers usually block this; use the desktop or Android app, or import an .ics file.`);
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new ValidationError(`The calendar server refused the address (${res.status}). Check that it’s the private/secret address and still valid.`);
    if (res.status < 200 || res.status >= 300) throw new ValidationError(`The calendar server answered ${res.status}`);
    return res.body;
  }

  async refresh(id: string): Promise<number> {
    const src = this.r.calendars.get(id);
    if (!src || src.kind !== 'url') return 0;
    const url = await this.secrets.get(secretKey(id));
    if (!url) {
      this.r.calendars.setSyncResult(id, 'Address needed: enter it again to refresh');
      throw new ValidationError(`Enter the address for “${src.name}” again to refresh it`);
    }
    try {
      return this.store(id, await this.fetch(url));
    } catch (err) {
      const msg = err instanceof ValidationError || err instanceof IcsError ? err.message : 'Refresh failed';
      this.r.calendars.setSyncResult(id, msg);
      throw err instanceof IcsError ? new ValidationError(err.message) : err;
    }
  }

  /** Refresh every subscribed calendar; errors are recorded per calendar, not thrown. */
  async refreshAll(): Promise<void> {
    for (const s of this.sources()) {
      if (s.kind !== 'url') continue;
      try {
        await this.refresh(s.id);
      } catch {
        // recorded in last_error
      }
    }
  }

  update(id: string, patch: Partial<Pick<CalendarSource, 'name' | 'color' | 'visible' | 'blocksTime'>>) {
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('A calendar needs a name');
    this.r.calendars.update(id, patch);
  }

  async remove(id: string): Promise<void> {
    this.r.calendars.remove(id);
    await this.secrets.delete(secretKey(id));
  }

  /** Events to display between two local dates (visible calendars). */
  events(from: ISODate, to: ISODate): (StoredEvent & { color: string; calendar: string })[] {
    const byId = new Map(this.sources().map((s) => [s.id, s]));
    return this.r.calendars.eventsBetween(from, to).map((e) => ({ ...e, color: byId.get(e.sourceId)?.color ?? '#64748b', calendar: byId.get(e.sourceId)?.name ?? '' }));
  }

  /** Busy minutes per day from calendars that block time (for workload and scheduling). */
  busy(from: ISODate, to: ISODate): Map<ISODate, number> {
    const hours = this.r.settings.getAll().workingHours;
    return busyMinutesByDay(this.r.calendars.eventsBetween(from, to, { only: 'blocking' }), hours, from, to);
  }

  blockingEvents(from: ISODate, to: ISODate): StoredEvent[] {
    return this.r.calendars.eventsBetween(from, to, { only: 'blocking' });
  }

  /** Open, scheduled tasks (optionally one project) as an .ics file. */
  exportIcs(opts: { projectId?: string | null } = {}): { filename: string; text: string; count: number } {
    const s = this.r.settings.getAll();
    let tasks = this.r.tasks.listForFilters().filter((t) => isOpenStatus(t.status) && t.scheduledDate);
    let name = 'Focus tasks';
    if (opts.projectId) {
      const p = this.r.projects.get(opts.projectId);
      if (!p) throw new ValidationError('Project not found');
      tasks = tasks.filter((t) => t.projectId === opts.projectId);
      name = `Focus – ${p.name}`;
    }
    const text = buildIcs(tasks, { name, defaultMinutes: s.defaultEstimate || 30, now: this.now() });
    const slug = name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return { filename: `${slug}.ics`, text, count: tasks.length };
  }
}
