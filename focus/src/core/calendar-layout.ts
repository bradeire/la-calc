/**
 * Side-by-side layout for overlapping time blocks within one day.
 * Blocks in a cluster of mutual overlaps share its width equally; each block
 * takes the first free column.
 */
export interface Block {
  id: string;
  start: number; // minutes from midnight
  end: number;
}

export interface Placed extends Block {
  column: number;
  columns: number;
}

export function layoutDay(blocks: readonly Block[]): Placed[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.column + 1));
    for (const p of cluster) p.columns = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const b of sorted) {
    if (b.start >= clusterEnd && cluster.length) flush();
    const taken = new Set(cluster.filter((p) => p.end > b.start).map((p) => p.column));
    let col = 0;
    while (taken.has(col)) col++;
    cluster.push({ ...b, column: col, columns: 1 });
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  if (cluster.length) flush();
  return out;
}

export const snap = (minutes: number, step = 15) => Math.round(minutes / step) * step;

export const toHHMM = (minutes: number) => {
  const m = Math.max(0, Math.min(24 * 60 - 1, minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const fromHHMM = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
