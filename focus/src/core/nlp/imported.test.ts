import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './parser';

// Tuesday 17 November 2026, as in the reported screenshots.
const now = new Date(2026, 10, 17, 9, 0);
const imp = (text: string) => parseQuickAdd(text, { now, imported: true });

describe('imported text is read conservatively', () => {
  it('ignores dates in brackets and still finds "tomorrow"', () => {
    const r = imp('Check Ombudsman Services portal messages (5 and 11 Nov) re Octopus A-0669E91B Remedy 2 tomorrow');
    expect(r.title).toBe('Check Ombudsman Services portal messages (5 and 11 Nov) re Octopus A-0669E91B Remedy 2');
    expect(r.scheduledDate).toBe('2026-11-18');
  });

  it('keeps bracketed notes whole, dates included', () => {
    const r = imp('Renew or switch Tesco home insurance TI00002139573 (not auto-renewing, ends 21 Nov) by Friday @calls');
    expect(r.title).toBe('Renew or switch Tesco home insurance TI00002139573 (not auto-renewing, ends 21 Nov)');
    expect(r.deadline).toBe('2026-11-20');
    expect(r.scheduledDate).toBeNull();
  });

  it('a recently passed day and month stays text instead of jumping to next year', () => {
    const r = imp('Chase refund promised 11 Nov');
    expect(r.scheduledDate).toBeNull();
    expect(r.title).toBe('Chase refund promised 11 Nov');
    // With a year, or far enough ahead, dates still count.
    expect(imp('Pay deposit 11 Nov 2027').scheduledDate).toBe('2027-11-11');
    expect(imp('Book MOT 3 Feb').scheduledDate).toBe('2027-02-03');
    expect(imp('Send card 25 Dec').scheduledDate).toBe('2026-12-25');
  });

  it('brackets protect priority, times and labels too', () => {
    const r = imp('Call bank (ref p1 at 3pm) p3');
    expect(r.priority).toBe(3);
    expect(r.scheduledTime).toBeNull();
    expect(r.title).toBe('Call bank (ref p1 at 3pm)');
  });

  it('typed Quick Add is unchanged', () => {
    expect(parseQuickAdd('Chase refund 11 Nov', { now }).scheduledDate).toBe('2027-11-11');
  });
});
