import {
  BookOpen, Briefcase, Calendar as CalendarIcon, CalendarClock, Car, Code, Dumbbell, Flag, Folder, GraduationCap, Hammer, Heart,
  House, Leaf, Map, Music, Plane, Repeat, ShoppingCart, Star, Tag, Timer, Wallet, type LucideIcon,
} from 'lucide-react';
import { diffDays, formatDuration, formatRelativeDate, formatTime, type DatePrefs } from '@/core/dates';
import type { Label, Priority, Task } from '@/core/domain/types';
import { cx } from '../primitives';

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder, house: House, briefcase: Briefcase, hammer: Hammer, map: Map, book: BookOpen, heart: Heart, star: Star,
  dumbbell: Dumbbell, plane: Plane, cart: ShoppingCart, school: GraduationCap, wallet: Wallet, code: Code, music: Music,
  leaf: Leaf, car: Car,
};

export function ProjectIcon({ icon, color, size = 16 }: { icon: string; color: string; size?: number }) {
  const I = PROJECT_ICONS[icon] ?? Folder;
  return <I size={size} style={{ color }} aria-hidden className="shrink-0" />;
}

export const PRIORITY_COLOR: Record<Priority, string> = { 1: 'var(--p1)', 2: 'var(--p2)', 3: 'var(--p3)', 4: 'var(--p4)' };
export const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'Priority 4' };

export function PriorityFlag({ p, size = 15 }: { p: Priority; size?: number }) {
  return <Flag size={size} style={{ color: PRIORITY_COLOR[p] }} fill={p < 4 ? PRIORITY_COLOR[p] : 'none'} aria-label={PRIORITY_LABEL[p]} />;
}

function dateTone(date: string, today: string): string {
  const d = diffDays(date, today);
  if (d < 0) return 'text-danger';
  if (d === 0) return 'text-ok';
  if (d === 1) return 'text-warn';
  if (d < 7) return 'text-p3';
  return 'text-muted';
}

export function ScheduledChip({ task, today, prefs }: { task: Pick<Task, 'scheduledDate' | 'scheduledTime' | 'recurrence'>; today: string; prefs: DatePrefs }) {
  if (!task.scheduledDate) return null;
  return (
    <span className={cx('inline-flex items-center gap-1', dateTone(task.scheduledDate, today))}>
      {task.recurrence ? <Repeat size={12} aria-label="Repeats" /> : <CalendarIcon size={12} aria-hidden />}
      {formatRelativeDate(task.scheduledDate, today, prefs)}
      {task.scheduledTime && ` ${formatTime(task.scheduledTime, prefs)}`}
    </span>
  );
}

export function DeadlineChip({ deadline, today, prefs }: { deadline: string | null; today: string; prefs: DatePrefs }) {
  if (!deadline) return null;
  const d = diffDays(deadline, today);
  return (
    <span className={cx('inline-flex items-center gap-1', d < 0 ? 'text-danger font-medium' : d <= 2 ? 'text-warn' : 'text-muted')} title="Deadline">
      <CalendarClock size={12} aria-hidden />
      <span className="sr-only">Deadline </span>
      {formatRelativeDate(deadline, today, prefs)}
    </span>
  );
}

export function DurationChip({ minutes }: { minutes: number | null }) {
  if (!minutes) return null;
  return (
    <span className="inline-flex items-center gap-1 text-muted">
      <Timer size={12} aria-hidden />
      <span className="sr-only">Estimate </span>
      {formatDuration(minutes)}
    </span>
  );
}

export function LabelChip({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-px text-[0.78rem]" style={{ color: readableColor(label.color) }}>
      <Tag size={11} aria-hidden />
      {label.name}
      {onRemove && (
        <button type="button" aria-label={`Remove label ${label.name}`} onClick={onRemove} className="ml-0.5 text-muted hover:text-fg">
          ×
        </button>
      )}
    </span>
  );
}

export function ProgressRing({ done, total, size = 14 }: { done: number; total: number; size?: number }) {
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`${done} of ${total} subtasks done`} role="img">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * User-chosen colours used as text: blend toward the foreground colour so the
 * result meets contrast requirements on both light and dark surfaces.
 */
export function readableColor(color: string): string {
  return `color-mix(in srgb, ${color} 62%, var(--fg))`;
}
