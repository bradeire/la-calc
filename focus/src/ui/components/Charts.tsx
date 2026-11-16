import { useState, type ReactNode } from 'react';
import { cx } from '../primitives';

/**
 * Small, dependency-free charts for Insights. Marks carry the series colour; text uses
 * text tokens. Every chart has a table alternative (see ChartCard) so nothing depends
 * on colour or hover alone.
 */
export interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Axis maximum whose half is also a clean number (ticks at 0, ½, max). */
export const niceMax = (n: number) => {
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  return [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10].find((m) => m * pow >= n)! * pow;
};

export function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-muted" aria-label="Legend">
      {series.map((s) => (
        <li key={s.name} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** Vertical columns per period; grouped, or stacked when `stacked`. */
export function ColumnChart({
  labels,
  longLabels,
  series,
  stacked = false,
  format = (n) => String(n),
  ariaLabel,
  marker,
}: {
  /** Optional reference value per column (e.g. capacity), drawn as a short dark line. */
  marker?: { name: string; values: number[] };
  labels: string[];
  longLabels?: string[];
  series: Series[];
  stacked?: boolean;
  format?: (n: number) => string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = labels.map((_, i) => Math.max(marker?.values[i] ?? 0, stacked ? series.reduce((s, x) => s + (x.values[i] ?? 0), 0) : Math.max(0, ...series.map((x) => x.values[i] ?? 0))));
  const max = niceMax(Math.max(0, ...totals));
  const every = Math.max(1, Math.ceil(labels.length / 8));
  const H = 150;
  const barW = stacked || series.length === 1 ? 24 : 12;
  return (
    <figure className="m-0" aria-label={ariaLabel}>
      {marker ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-muted" aria-label="Legend">
          {series.map((x) => (
            <li key={x.name} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: x.color }} />
              {x.name}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-3.5 bg-fg" />
            {marker.name}
          </li>
        </ul>
      ) : (
        <Legend series={series} />
      )}
      <div className="relative" style={{ height: H + 22 }} onMouseLeave={() => setHover(null)}>
        {/* Gridlines and y ticks: recessive hairlines. */}
        {[0, 0.5, 1].map((f) => (
          <div key={f} aria-hidden className="absolute right-0 left-8 border-t border-line" style={{ top: H - f * H }}>
            <span className="absolute -top-2 -left-8 w-7 text-right text-[0.7rem] tabular-nums text-subtle">{format(Math.round(max * f))}</span>
          </div>
        ))}
        <div aria-hidden className="absolute top-0 right-0 left-8 flex items-end" style={{ height: H }}>
          {labels.map((_, i) => (
            <div key={i} className="relative flex h-full flex-1 items-end justify-center gap-[2px]" onMouseEnter={() => setHover(i)}>
              {hover === i && <div className="absolute inset-y-0 left-0 right-0 rounded bg-surface-2" />}
              {marker && (marker.values[i] ?? 0) > 0 && <div className="absolute left-1/2 z-[1] h-0.5 w-8 -translate-x-1/2 rounded bg-fg" style={{ bottom: ((marker.values[i] ?? 0) / max) * H - 1 }} />}
              {stacked ? (
                <div className="relative flex flex-col-reverse gap-[2px]" style={{ width: barW }}>
                  {series.map((s) => {
                    const v = s.values[i] ?? 0;
                    return v > 0 ? <div key={s.name} className="rounded-[4px] first:rounded-b-none" style={{ height: Math.max(2, (v / max) * H - 2), background: s.color }} /> : null;
                  })}
                </div>
              ) : (
                series.map((s) => {
                  const v = s.values[i] ?? 0;
                  return <div key={s.name} className="relative rounded-t-[4px]" style={{ width: barW, height: v > 0 ? Math.max(2, (v / max) * H) : 0, background: s.color }} />;
                })
              )}
            </div>
          ))}
        </div>
        <div aria-hidden className="absolute right-0 left-8 flex" style={{ top: H + 4 }}>
          {labels.map((l, i) => (
            <div key={i} className="flex-1 truncate text-center text-[0.7rem] text-subtle">
              {i % every === 0 ? l : ''}
            </div>
          ))}
        </div>
        {hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.78rem] shadow-[var(--shadow)]"
            style={{ left: `calc(2rem + ${((hover + 0.5) / labels.length) * 100}% - ${((hover + 0.5) / labels.length) * 2}rem)`, top: 0, transform: `translateX(${hover / labels.length > 0.6 ? '-105%' : '5%'})` }}
          >
            <div className="font-medium">{longLabels?.[hover] ?? labels[hover]}</div>
            {series.map((s) => (
              <div key={s.name} className="flex items-center gap-1.5 text-muted">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                {s.name}: <span className="tabular-nums text-fg">{format(s.values[hover] ?? 0)}</span>
              </div>
            ))}
            {marker && (
              <div className="flex items-center gap-1.5 text-muted">
                <span className="inline-block h-0.5 w-2 bg-fg" />
                {marker.name}: <span className="tabular-nums text-fg">{format(marker.values[hover] ?? 0)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}

/** Horizontal bars with the label on the left and the value at the tip. */
export function BarList({ rows, format = (n) => String(n), color = 'var(--viz-1)', ariaLabel }: { rows: { label: ReactNode; value: number; key: string }[]; format?: (n: number) => string; color?: string; ariaLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-1.5" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-2 text-[0.85rem]">
          <span className="truncate">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="h-3 rounded-r-[4px]" style={{ width: `${(r.value / max) * 85}%`, minWidth: r.value ? 2 : 0, background: color }} />
            <span className="tabular-nums text-muted">{format(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Simple accessible table, used as the alternative to every chart. */
export function DataTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[0.85rem]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-subtle">
            {columns.map((c, i) => (
              <th key={c} scope="col" className={cx('py-1.5 font-medium', i > 0 && 'text-right')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cx('py-1.5', j > 0 && 'text-right tabular-nums')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Thin progress bar with a text value beside it (never colour alone). */
export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className="h-full rounded-full bg-[var(--viz-1)]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right text-[0.8rem] tabular-nums text-muted">{pct}%</span>
    </div>
  );
}
