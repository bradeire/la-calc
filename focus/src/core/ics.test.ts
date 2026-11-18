import { describe, expect, it } from 'vitest';
import type { Task } from './domain/types';
import { buildIcs, busyMinutesByDay, IcsError, overlappingEvents, parseIcs } from './ics';

const crlf = (s: string) => s.trim().split('\n').map((l) => l.trim()).join('\r\n');

// Europe/London as Google publishes it (BST/GMT rules).
const LONDON = `BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

const GOOGLE = crlf(`BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
${LONDON}
BEGIN:VEVENT
UID:dentist@google.com
DTSTART;TZID=Europe/London:20261020T090000
DTEND;TZID=Europe/London:20261020T093000
SUMMARY:Dentist
LOCATION:High St
END:VEVENT
BEGIN:VEVENT
UID:swim@google.com
DTSTART;TZID=Europe/London:20261102T180000
DTEND;TZID=Europe/London:20261102T190000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6
EXDATE;TZID=Europe/London:20261109T180000
SUMMARY:Swimming
END:VEVENT
BEGIN:VEVENT
UID:swim@google.com
RECURRENCE-ID;TZID=Europe/London:20261116T180000
DTSTART;TZID=Europe/London:20261116T190000
DTEND;TZID=Europe/London:20261116T200000
SUMMARY:Swimming (late)
END:VEVENT
BEGIN:VEVENT
UID:holiday@google.com
DTSTART;VALUE=DATE:20261224
DTEND;VALUE=DATE:20261227
SUMMARY:Christmas break
END:VEVENT
BEGIN:VEVENT
UID:gone@google.com
DTSTART:20261118T120000Z
DTEND:20261118T130000Z
STATUS:CANCELLED
SUMMARY:Cancelled lunch
END:VEVENT
END:VCALENDAR`);

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') };

describe('ics import', () => {
  it('converts time-zoned events to UTC, including across the clock change', () => {
    const evs = parseIcs(GOOGLE, window);
    const dentist = evs.find((e) => e.uid === 'dentist@google.com')!;
    // 20 Oct is British Summer Time (UTC+1).
    expect(dentist).toMatchObject({ title: 'Dentist', location: 'High St', allDay: false, start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:30:00.000Z' });
  });

  it('expands repeats, skips EXDATEs, applies moved occurrences and drops cancelled events', () => {
    const swims = parseIcs(GOOGLE, window).filter((e) => e.uid === 'swim@google.com');
    // 6 Mondays from 2 Nov, minus 9 Nov; November is GMT.
    expect(swims.map((s) => s.start)).toEqual([
      '2026-11-02T18:00:00.000Z',
      '2026-11-16T19:00:00.000Z',
      '2026-11-23T18:00:00.000Z',
      '2026-11-30T18:00:00.000Z',
      '2026-12-07T18:00:00.000Z',
    ]);
    expect(swims[1]!.title).toBe('Swimming (late)');
    expect(parseIcs(GOOGLE, window).some((e) => e.title === 'Cancelled lunch')).toBe(false);
  });

  it('keeps all-day events as dates with an exclusive end', () => {
    expect(parseIcs(GOOGLE, window).find((e) => e.allDay)).toMatchObject({ title: 'Christmas break', start: '2026-12-24', end: '2026-12-27' });
  });

  it('limits results to the window and rejects non-calendars', () => {
    const nov = parseIcs(GOOGLE, { from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-20T00:00:00Z') });
    expect(nov.map((e) => e.title)).toEqual(['Swimming (late)']);
    expect(() => parseIcs('hello', window)).toThrow(IcsError);
    expect(() => parseIcs(crlf('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD'), window)).toThrow(IcsError);
  });

  it('reads an Outlook calendar with a Windows time zone definition', () => {
    const outlook = crlf(`BEGIN:VCALENDAR
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:GMT Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E008
SUMMARY:Parents' evening
DTSTART;TZID=GMT Standard Time:20260707T170000
DTEND;TZID=GMT Standard Time:20260707T183000
END:VEVENT
END:VCALENDAR`);
    const [e] = parseIcs(outlook, { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') });
    expect(e).toMatchObject({ title: "Parents' evening", start: '2026-07-07T16:00:00.000Z', end: '2026-07-07T17:30:00.000Z' });
  });
});

describe('availability', () => {
  it('counts busy minutes inside working hours, merging overlaps', () => {
    const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
    const evs = [
      { uid: 'a', title: 'A', location: '', allDay: false, start: local(16, 8), end: local(16, 10) }, // 1h inside 9–17
      { uid: 'b', title: 'B', location: '', allDay: false, start: local(16, 9, 30), end: local(16, 11) }, // overlaps A
      { uid: 'c', title: 'C', location: '', allDay: true, start: '2026-11-16', end: '2026-11-17' },
    ];
    expect(busyMinutesByDay(evs, { start: '09:00', end: '17:00' }, '2026-11-16', '2026-11-17')).toEqual(new Map([['2026-11-16', 120]]));
    expect(overlappingEvents({ scheduledDate: '2026-11-16', scheduledTime: '10:30', durationMinutes: 60 }, evs).map((e) => e.uid)).toEqual(['b']);
    expect(overlappingEvents({ scheduledDate: '2026-11-16', scheduledTime: '11:00', durationMinutes: 60 }, evs)).toEqual([]);
  });
});

describe('ics export', () => {
  const base = { description: '', projectId: null, sectionId: null, parentId: null, priority: 4, status: 'active', startDate: null, scheduledTime: null, deadline: null, durationMinutes: null, actualMinutes: 0, completedAt: null, createdAt: '', updatedAt: '', deletedAt: null, sortOrder: 0, pinnedToday: false, collapsed: false, seriesId: null, recurrence: null, recurrenceText: null, labelIds: [], isSample: false } as const;
  it('exports dated tasks that re-import as the same events', () => {
    const tasks = [
      { ...base, id: 't1', title: 'Call plumber, re: leak; urgent', scheduledDate: '2026-11-18', scheduledTime: '14:00', durationMinutes: 45 },
      { ...base, id: 't2', title: 'Bins out', scheduledDate: '2026-11-19' },
      { ...base, id: 't3', title: 'Someday', scheduledDate: null },
    ] as unknown as Task[];
    const ics = buildIcs(tasks, { name: 'Focus', defaultMinutes: 30, now: new Date('2026-11-16T00:00:00Z') });
    expect(ics).toContain('\r\n');
    expect(ics).toContain('SUMMARY:Call plumber\\, re: leak\\; urgent');
    const back = parseIcs(ics, { from: new Date(2026, 10, 1), to: new Date(2026, 11, 1) });
    expect(back.map((e) => e.title)).toEqual(['Call plumber, re: leak; urgent', 'Bins out']);
    expect(back[0]).toMatchObject({ uid: 't1@focus.local', start: new Date(2026, 10, 18, 14).toISOString(), end: new Date(2026, 10, 18, 14, 45).toISOString() });
    expect(back[1]).toMatchObject({ allDay: true, start: '2026-11-19', end: '2026-11-20' });
  });
});
