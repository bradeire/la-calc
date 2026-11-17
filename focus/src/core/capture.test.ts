import { describe, expect, it } from 'vitest';
import { extractCandidates, parseSource } from './capture';

const now = new Date(2026, 10, 16, 9); // Monday
const titles = (text: string) => extractCandidates(text, { now }).candidates.map((c) => c.parsed.title);

describe('email parsing', () => {
  const email = `From: Sarah Jones <sarah@example.com>
To: me@example.com
Subject: Kitchen quote
Date: Mon, 16 Nov 2026 08:12

Hi,

Thanks for getting in touch. Could you send me photos of the current units by Friday? Please confirm the measurements as well.

I'll book the survey once I have them.

Best,
Sarah
--
Jones & Sons Kitchens

On Sun, 15 Nov 2026 at 20:00, Me wrote:
> Could you quote for a new kitchen?
> Please call me back.`;

  it('reads headers and drops quoted history and signature', () => {
    const s = parseSource(email);
    expect(s).toMatchObject({ kind: 'email', subject: 'Kitchen quote', from: 'Sarah Jones <sarah@example.com>' });
    expect(s.body).not.toContain('quote for a new kitchen');
    expect(s.body).not.toContain('Jones & Sons Kitchens');
  });

  it('extracts requests with their dates', () => {
    const { candidates } = extractCandidates(email, { now });
    const photos = candidates.find((c) => /photos/.test(c.parsed.title))!;
    expect(photos.parsed.title).toBe('Send me photos of the current units');
    expect(photos.parsed.deadline).toBe('2026-11-20');
    expect(candidates.map((c) => c.parsed.title)).toContain('Confirm the measurements');
    // "I'll book the survey" is Sarah's commitment in her email, but from the reader's view it is still captured as a possible follow-up
    expect(candidates.some((c) => /quote for a new kitchen|call me back/i.test(c.text))).toBe(false);
  });
});

describe('meeting notes', () => {
  it('finds checkboxes, prefixed actions, owners and action-section bullets', () => {
    const notes = `# Project sync 16/11

Discussed the launch timeline. Budget approved.

- [ ] Draft press release by Wednesday p1
- [x] Book venue
- Decision: go with option B
TODO: renew domain name next week

## Action items
- Priya to share the design files
- Update the risk register
- Agree budget with finance #Work

## Notes
- The venue has parking`;
    const t = titles(notes);
    expect(t).toEqual(['Draft press release', 'Renew domain name', 'Priya: share the design files', 'Update the risk register', 'Agree budget with finance']);
    const pr = extractCandidates(notes, { now }).candidates[0]!;
    expect(pr.parsed).toMatchObject({ priority: 1, deadline: '2026-11-18' });
    expect(pr.confidence).toBe('high');
  });

  it('ignores plain prose and completed items', () => {
    expect(titles('The weather was nice.\n- [x] Done already\nWe talked about holidays.')).toEqual([]);
  });

  it('picks up imperative bullets and commitments outside action sections', () => {
    expect(titles('- Call the bank about the mortgage\n- the bank was closed\nI will email Tom tomorrow')).toEqual(['Call the bank about the mortgage', 'Email Tom']);
  });

  it('drops filler words', () => {
    expect(titles('Could you also check the boiler warranty? Please just send the invoice as well.')).toEqual(['Check the boiler warranty', 'Send the invoice']);
  });

  it('deduplicates', () => {
    expect(titles('- [ ] Send invoice\nTODO: send invoice')).toEqual(['Send invoice']);
  });
});

describe('lists and Focus links', () => {
  const now2 = new Date('2026-11-17T09:00:00');
  const pick = (text: string, opts = {}) => extractCandidates(text, { now: now2 }, opts).candidates;

  it('takes a plain to-do list line by line when nothing else looks like an action', () => {
    const c = pick('Paint fence\nDentist Friday 10am\nGarden tidy #Home p2');
    expect(c.map((x) => x.parsed.title)).toEqual(['Paint fence', 'Dentist', 'Garden tidy']);
    expect(c.every((x) => x.confidence === 'high')).toBe(true);
  });

  it('skips the chatty lines around a copied list', () => {
    expect(pick('Here are your tasks:\n\nPaint fence\nMow lawn Saturday\n\nWant me to add more?').map((x) => x.parsed.title)).toEqual(['Paint fence', 'Mow lawn']);
  });

  it('still ignores prose', () => {
    expect(pick('The weather was lovely today.\nWe talked about holidays.')).toHaveLength(0);
  });

  it('reads tasks from a pasted Claude reply with focus:// and relay /open links', () => {
    const reply = [
      'Here you go:',
      '- [Phone dentist Friday](focus://add?text=Phone%20dentist%20Friday%20%23Home)',
      '- [Buy paint](https://focus-sync.me.workers.dev/open#add?text=Buy%20paint%20p2)',
      '[Add all](https://focus-sync.me.workers.dev/open#capture?text=Phone%20dentist%20Friday%20%23Home%0ABuy%20paint%20p2%0AMow%20lawn)',
      '',
      'Plain list:',
      '1. Phone dentist Friday #Home',
    ].join('\n');
    const c = pick(reply);
    expect(c.map((x) => x.text)).toEqual(['Phone dentist Friday #Home', 'Buy paint p2', 'Mow lawn']);
    expect(c.every((x) => x.confidence === 'high')).toBe(true);
  });

  it('list mode (from a Focus link) takes every line, even sentences', () => {
    const c = pick('Fix the gate.\n- [ ] Call Mum\n- [x] Done already', { list: true });
    expect(c.map((x) => x.parsed.title)).toEqual(['Fix the gate', 'Call Mum']);
  });
});
