import type { ExternalEvent } from '@/core/ics';
import type { DatabaseDriver, Row } from '../db/driver';
import { bool, newId, nowIso, str, strOrNull, track } from './base';

export interface CalendarSource {
  id: string;
  name: string;
  color: string;
  kind: 'url' | 'file';
  visible: boolean;
  /** Whether its events reduce available time for workload and scheduling. */
  blocksTime: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  eventCount: number;
}

export interface StoredEvent extends ExternalEvent {
  id: string;
  sourceId: string;
}

const mapSource = (r: Row): CalendarSource => ({
  id: str(r.id),
  name: str(r.name),
  color: str(r.color),
  kind: str(r.kind) as 'url' | 'file',
  visible: bool(r.visible),
  blocksTime: bool(r.blocks_time),
  lastSyncedAt: strOrNull(r.last_synced_at),
  lastError: strOrNull(r.last_error),
  eventCount: Number(r.event_count ?? 0),
});
const mapEvent = (r: Row): StoredEvent => ({
  id: str(r.id),
  sourceId: str(r.source_id),
  uid: str(r.uid),
  title: str(r.title),
  location: str(r.location),
  allDay: bool(r.all_day),
  start: str(r.start_at),
  end: str(r.end_at),
});

export class CalendarRepository {
  constructor(private db: DatabaseDriver) {}

  insert(s: { name: string; color: string; kind: 'url' | 'file' }): string {
    const id = newId();
    const ts = nowIso();
    this.db.run('INSERT INTO calendar_sources (id, name, color, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, s.name, s.color, s.kind, ts, ts]);
    track(this.db, 'calendar_sources', id, 'insert');
    return id;
  }
  update(id: string, patch: Partial<Pick<CalendarSource, 'name' | 'color' | 'visible' | 'blocksTime'>>) {
    const cur = this.get(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    this.db.run('UPDATE calendar_sources SET name = ?, color = ?, visible = ?, blocks_time = ?, updated_at = ? WHERE id = ?', [n.name, n.color, n.visible ? 1 : 0, n.blocksTime ? 1 : 0, nowIso(), id]);
    track(this.db, 'calendar_sources', id, 'update');
  }
  setSyncResult(id: string, error: string | null) {
    const ts = nowIso();
    if (error) this.db.run('UPDATE calendar_sources SET last_error = ?, updated_at = ? WHERE id = ?', [error, ts, id]);
    else this.db.run('UPDATE calendar_sources SET last_error = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?', [ts, ts, id]);
  }
  /** Replace all cached events of a source. */
  replaceEvents(sourceId: string, events: readonly ExternalEvent[]) {
    this.db.run('DELETE FROM external_events WHERE source_id = ?', [sourceId]);
    for (const e of events) {
      this.db.run('INSERT INTO external_events (id, source_id, uid, title, location, all_day, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        newId(),
        sourceId,
        e.uid,
        e.title,
        e.location,
        e.allDay ? 1 : 0,
        e.start,
        e.end,
      ]);
    }
  }
  remove(id: string) {
    this.db.run('DELETE FROM external_events WHERE source_id = ?', [id]);
    this.db.run('UPDATE calendar_sources SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);
    track(this.db, 'calendar_sources', id, 'update');
  }
  list(): CalendarSource[] {
    return this.db
      .all('SELECT s.*, (SELECT COUNT(*) FROM external_events e WHERE e.source_id = s.id) AS event_count FROM calendar_sources s WHERE s.deleted_at IS NULL ORDER BY s.created_at')
      .map(mapSource);
  }
  get(id: string): CalendarSource | undefined {
    return this.list().find((s) => s.id === id);
  }
  /**
   * Events overlapping [fromDate, toDate] (local dates), from visible (or time-blocking) sources.
   * Timed events are compared as UTC instants, all-day ones as dates.
   */
  eventsBetween(fromDate: string, toDate: string, opts: { only?: 'visible' | 'blocking' } = {}): StoredEvent[] {
    const flag = opts.only === 'blocking' ? 's.blocks_time = 1' : 's.visible = 1';
    const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
    const [y, m, d] = toDate.split('-').map(Number) as [number, number, number];
    const toIso = new Date(y, m - 1, d + 1).toISOString();
    return this.db
      .all(
        `SELECT e.* FROM external_events e JOIN calendar_sources s ON s.id = e.source_id
         WHERE s.deleted_at IS NULL AND ${flag}
           AND ((e.all_day = 0 AND e.start_at < ? AND e.end_at > ?) OR (e.all_day = 1 AND e.start_at <= ? AND e.end_at > ?))
         ORDER BY e.start_at`,
        [toIso, fromIso, toDate, fromDate],
      )
      .map(mapEvent);
  }
}
