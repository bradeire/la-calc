import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/services/events';
import { normaliseCalendarUrl } from '@/services/calendar-service';
import { makeApp } from './helpers';

const NOW = new Date(2026, 10, 16, 8, 0); // Monday 16 Nov 2026
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:meeting-1',
  `DTSTART:${stamp(new Date(2026, 10, 16, 10, 0))}`,
  `DTEND:${stamp(new Date(2026, 10, 16, 12, 0))}`,
  'SUMMARY:School meeting',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('external calendars', () => {
  it('subscribes by address, keeps the address out of the database, and blocks time', async () => {
    const { app, platform, db } = await makeApp(NOW);
    platform.http.handler = (r) => (r.url === 'https://calendar.example.com/private-abc/basic.ics' ? { status: 200, body: ICS } : { status: 404, body: '' });
    const id = await app.calendars.addUrl({ name: 'Family', url: 'webcal://calendar.example.com/private-abc/basic.ics', color: '#0f766e' });
    expect(app.calendars.sources()).toMatchObject([{ id, name: 'Family', kind: 'url', eventCount: 1, lastError: null }]);
    expect(await platform.secrets.get(`calendar:${id}`)).toBe('https://calendar.example.com/private-abc/basic.ics');
    // The private address never reaches SQLite.
    expect(new TextDecoder('latin1').decode(db.export())).not.toContain('private-abc');

    expect(app.calendars.events('2026-11-16', '2026-11-16')).toMatchObject([{ title: 'School meeting', calendar: 'Family', color: '#0f766e' }]);
    // 09:00–17:30 working day minus a two-hour meeting.
    const [mon] = app.planning.workload('2026-11-16', '2026-11-16');
    expect(mon!.capacity).toBe(8.5 * 60 - 120);

    const t = app.tasks.create({ title: 'Call garage', scheduledDate: '2026-11-16', scheduledTime: '11:00', durationMinutes: 30 });
    expect(app.planning.conflicts()).toContainEqual({ kind: 'eventClash', taskId: t.id, eventTitle: 'School meeting' });

    // Not blocking time: capacity is back and no clash is reported.
    app.calendars.update(id, { blocksTime: false });
    expect(app.planning.workload('2026-11-16', '2026-11-16')[0]!.capacity).toBe(8.5 * 60);
    expect(app.planning.conflicts().some((c) => c.kind === 'eventClash')).toBe(false);

    await app.calendars.remove(id);
    expect(app.calendars.sources()).toEqual([]);
    expect(await platform.secrets.get(`calendar:${id}`)).toBeNull();
  });

  it('reports refresh problems clearly and keeps the previous events', async () => {
    const { app, platform } = await makeApp(NOW);
    platform.http.handler = () => ({ status: 200, body: ICS });
    const id = await app.calendars.addUrl({ name: 'Work', url: 'https://example.com/a.ics', color: '#2563eb' });
    platform.http.handler = () => ({ status: 403, body: 'nope' });
    await expect(app.calendars.refresh(id)).rejects.toThrow(/refused the address \(403\)/);
    expect(app.calendars.sources()[0]).toMatchObject({ eventCount: 1, lastError: expect.stringMatching(/403/) });
    platform.http.handler = () => ({ status: 200, body: '<html>login</html>' });
    await expect(app.calendars.refresh(id)).rejects.toThrow(ValidationError);
    // A wrong address on adding leaves nothing behind.
    await expect(app.calendars.addUrl({ name: 'Bad', url: 'https://example.com/b.ics', color: '#000000' })).rejects.toThrow();
    expect(app.calendars.sources()).toHaveLength(1);
    expect(() => normaliseCalendarUrl('ftp://x')).toThrow(ValidationError);
    expect(() => normaliseCalendarUrl('not a url')).toThrow(ValidationError);
  });

  it('asks for the address again when the secret store forgot it (browser restart)', async () => {
    const { app, platform } = await makeApp(NOW);
    platform.http.handler = () => ({ status: 200, body: ICS });
    const id = await app.calendars.addUrl({ name: 'Home', url: 'https://example.com/h.ics', color: '#2563eb' });
    await platform.secrets.delete(`calendar:${id}`);
    expect(await app.calendars.hasAddress(id)).toBe(false);
    await expect(app.calendars.refresh(id)).rejects.toThrow(/again/);
    await app.calendars.setAddress(id, 'https://example.com/h.ics');
    expect(app.calendars.sources()[0]!.lastError).toBeNull();
  });

  it('imports an .ics file and exports scheduled tasks', async () => {
    const { app } = await makeApp(NOW);
    app.calendars.addFile({ name: 'School terms', text: ICS, color: '#be185d' });
    expect(app.calendars.sources()[0]).toMatchObject({ kind: 'file', eventCount: 1 });
    expect(() => app.calendars.addFile({ name: 'x', text: 'garbage', color: '#000000' })).toThrow(/calendar file/);

    const home = app.projects.create({ name: 'Home' });
    app.tasks.create({ title: 'Bins out', scheduledDate: '2026-11-19', projectId: home.id });
    app.tasks.create({ title: 'Undated' });
    app.tasks.create({ title: 'Elsewhere', scheduledDate: '2026-11-20' });
    const all = app.calendars.exportIcs();
    expect(all.count).toBe(2);
    expect(all.filename).toBe('focus-tasks.ics');
    const proj = app.calendars.exportIcs({ projectId: home.id });
    expect(proj.count).toBe(1);
    expect(proj.text).toContain('SUMMARY:Bins out');
    expect(proj.text).not.toContain('Elsewhere');
  });
});
