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
