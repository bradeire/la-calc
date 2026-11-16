import { describe, expect, it } from 'vitest';
import { buildAddLink, buildCaptureLink, buildSyncLink, MAX_ADD_LENGTH, parseIncomingLink } from './links';
import { parseQuickAdd } from './nlp/parser';

describe('tap-to-add links', () => {
  it('parses focus://add with an encoded Quick Add string', () => {
    expect(parseIncomingLink('focus://add?text=Phone%20dentist%20Friday%2010am%20%23Home%20p2')).toEqual({
      kind: 'add',
      text: 'Phone dentist Friday 10am #Home p2',
    });
  });

  it('accepts the scheme variants Android, Windows and the browser deliver', () => {
    for (const url of ['focus:add?text=Milk', 'focus:///add?text=Milk', 'FOCUS://ADD/?text=Milk', 'web+focus://add?text=Milk']) {
      expect(parseIncomingLink(url), url).toEqual({ kind: 'add', text: 'Milk' });
    }
    expect(parseIncomingLink('focus://add?text=Milk+and+eggs')).toEqual({ kind: 'add', text: 'Milk and eggs' });
  });

  it('routes multi-line text and capture links to the Capture dialog', () => {
    expect(parseIncomingLink('focus://add?text=Milk%0AEggs')).toEqual({ kind: 'capture', text: 'Milk\nEggs' });
    expect(parseIncomingLink('focus://capture?text=-%20Milk%0D%0A-%20Eggs')).toEqual({ kind: 'capture', text: '- Milk\n- Eggs' });
  });

  it('rejects other schemes, unknown actions and empty text', () => {
    for (const url of ['https://example.com/add?text=x', 'javascript:alert(1)', 'focus://delete?text=x', 'focus://add?text=%20%20', 'focus://add', 'not a url']) {
      expect(parseIncomingLink(url), url).toBeNull();
    }
  });

  it('strips control and bidi characters and caps length', () => {
    const r = parseIncomingLink(`focus://add?text=${encodeURIComponent('Pay\u0007 bill‮')}`);
    expect(r).toEqual({ kind: 'add', text: 'Pay bill' });
    const long = parseIncomingLink(`focus://add?text=${'a'.repeat(5000)}`);
    expect(long && 'text' in long ? long.text.length : 0).toBe(MAX_ADD_LENGTH);
  });

  it('round-trips through the link builders, keeping Quick Add tokens intact', () => {
    const text = "Book MOT by 20 Nov #Car p1 @admin (O'Neill & Sons)";
    expect(parseIncomingLink(buildAddLink(text))).toEqual({ kind: 'add', text });
    expect(buildAddLink(text)).not.toMatch(/[ #@&'()]/);
    expect(parseIncomingLink(buildCaptureLink('A\nB'))).toEqual({ kind: 'capture', text: 'A\nB' });
    const link = parseIncomingLink(buildAddLink('Phone dentist tomorrow 10am p2'));
    const parsed = parseQuickAdd(link && 'text' in link ? link.text : '', { now: new Date(2026, 10, 16, 9) });
    expect(parsed.title).toBe('Phone dentist');
    expect(parsed.priority).toBe(2);
  });

  it('parses sync join links and rejects insecure or malformed ones', () => {
    const key = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX';
    expect(parseIncomingLink(buildSyncLink('https://focus-sync.me.workers.dev', key))).toEqual({ kind: 'sync', relay: 'https://focus-sync.me.workers.dev', key });
    expect(parseIncomingLink(buildSyncLink('http://evil.example', key))).toBeNull();
    expect(parseIncomingLink(buildSyncLink('https://x.dev', 'short'))).toBeNull();
  });
});
