import { describe, expect, it } from 'vitest';
import { layoutDay, snap, toHHMM } from './calendar-layout';

describe('layoutDay', () => {
  it('non-overlapping blocks take the full width', () => {
    expect(layoutDay([{ id: 'a', start: 540, end: 600 }, { id: 'b', start: 600, end: 660 }]).map((p) => [p.id, p.column, p.columns])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ]);
  });
  it('overlaps share columns within their cluster only', () => {
    const r = layoutDay([
      { id: 'a', start: 540, end: 660 },
      { id: 'b', start: 570, end: 600 },
      { id: 'c', start: 600, end: 630 }, // reuses b's column
      { id: 'd', start: 720, end: 750 }, // separate cluster
    ]);
    const by = Object.fromEntries(r.map((p) => [p.id, [p.column, p.columns]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2], d: [0, 1] });
  });
});

it('snap and format', () => {
  expect(snap(547)).toBe(540);
  expect(snap(553)).toBe(555);
  expect(toHHMM(9 * 60 + 5)).toBe('09:05');
  expect(toHHMM(-30)).toBe('00:00');
});
